import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  createEditor,
  Descendant,
  Editor,
  Element as SlateElement,
  Node,
  Path,
  Point,
  Range,
  Text,
  Transforms,
  BaseEditor,
} from "slate";
import { Slate, Editable, ReactEditor, RenderLeafProps, withReact } from "slate-react";
import { withHistory, HistoryEditor } from "slate-history";
import { GoogleGenerativeAI } from "@google/generative-ai";

declare module "slate" {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor;
    Element: { type: "paragraph"; children: Descendant[] };
    Text: { text: string };
  }
}

/**
 * Demo goal:
 * - Show the "inline suggestion + Tab to apply" UX pattern in Slate.
 * - Provide a cheap rule-based set of fixes (fast, deterministic).
 * - Add a simple "POV / pronoun consistency" propagation example (he ↔ she ↔ they),
 *   inferred from the *sentence containing the cursor*.
 *
 * This is intentionally not "perfect grammar"—it's meant to be a clean MVP you can
 * swap later with LanguageTool/retext/LLM patches without changing the UI contract.
 */

type SuggestionKind =
  | "grammar"
  | "pov-pronoun-propagation";

type Suggestion = {
  id: string;
  kind: SuggestionKind;
  path: Path; // text node path
  range: Range; // slate range in that text node
  replacement: string;
  reason: string;
};

type CustomRule = {
  id: string;
  intent: string;
  pattern: string; // The regex pattern
  message: string;
  replacement: string;
  xml?: string;
};

const initialValue: Descendant[] = [
  {
    type: "paragraph",
    children: [
      {
        text:
          "This is  a demo. It fixes the the basics. Try typing a apple. " +
          "Now try POV propagation: “He walks into the room. He sits.” Then change one “He” to “She” and press Tab.",
      },
    ],
  },
  {
    type: "paragraph",
    children: [
      {
        text:
          "He said he would ship the feature, and his teammate agreed. " +
          "If you change the sentence to use she/her, the demo suggests aligning other gendered pronouns in the paragraph.",
      },
    ],
  },
];

function isParagraph(n: any): n is SlateElement {
  return SlateElement.isElement(n) && n.type === "paragraph";
}

function uid() {
  // Good enough for a demo
  return Math.random().toString(16).slice(2);
}

function getLocalGrammarSuggestions(text: string, customRules: CustomRule[] = []): any[] {
  const matches: any[] = [];

  // 1. Core local rules (It were)
  const itWereRe = /(?<!\b(if|wish|suppose|that)\s+)\b(it|she|he)\b\s+(were)\b/gi;
  for (const m of text.matchAll(itWereRe)) {
    const start = m.index ?? 0;
    const subject = m[2];
    matches.push({
      message: `Use "was" for indicative statements with "${subject}".`,
      offset: start,
      length: m[0].length,
      replacements: [{ value: `${subject} was` }]
    });
  }

  // 2. User-defined "AI" rules
  for (const rule of customRules) {
    try {
      const re = new RegExp(rule.pattern, "gi");
      for (const m of text.matchAll(re)) {
        const original = m[0];
        const replacement = rule.replacement ? matchCase(rule.replacement, original) : "";
        matches.push({
          message: rule.message,
          offset: m.index ?? 0,
          length: original.length,
          replacements: [{ value: replacement }]
        });
      }
    } catch (e) {
      console.error("Invalid custom rule pattern:", rule.pattern);
    }
  }

  return matches;
}

// ------------------------- Grammar engine (Hybrid) ----------------------------

async function getSuggestionsFromLT(
  text: string,
  language = "en-US",
  disabledCategories: string[] = []
): Promise<any[]> {
  try {
    const params = new URLSearchParams();
    params.append("text", text);
    params.append("language", language);
    if (disabledCategories.length > 0) {
      params.append("disabledCategories", disabledCategories.join(","));
    }

    const response = await fetch("https://api.languagetool.org/v2/check", {
      method: "POST",
      body: params,
    });
    const data = await response.json();
    return data.matches || [];
  } catch (err) {
    console.error("LanguageTool API error:", err);
    return [];
  }
}

async function getSuggestionsForParagraph(
  editor: Editor,
  paragraphPath: Path,
  selection: Range | null,
  customRules: CustomRule[] = [],
  settings: Record<string, boolean> = {},
  apiKey: string = ""
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  const paragraphText = Node.string(Node.get(editor, paragraphPath));
  if (!paragraphText.trim()) return [];

  // 1. Fetch from LanguageTool
  const disabledLTCategories = [];
  if (!settings.ltTypos) disabledLTCategories.push("TYPOS");
  if (!settings.ltGrammar) disabledLTCategories.push("GRAMMAR");
  if (!settings.ltStyle) disabledLTCategories.push("STYLE");
  if (!settings.ltPunctuation) disabledLTCategories.push("PUNCTUATION");

  const ltMatches = await getSuggestionsFromLT(paragraphText, "en-US", disabledLTCategories);

  // 2. Local & Custom Rules
  const localMatches = settings.localFallbacks ? getLocalGrammarSuggestions(paragraphText, customRules) : [];

  // Map Slate nodes to calculate absolute offsets correctly
  const paragraphTextNodes: Array<{ path: Path; text: string; start: number; end: number }> = [];
  let currentOffset = 0;
  for (const [n, p] of Node.texts(editor, { from: paragraphPath })) {
    const text = (n as Text).text;
    paragraphTextNodes.push({
      path: p,
      text: text,
      start: currentOffset,
      end: currentOffset + text.length,
    });
    currentOffset += text.length;
  }

  // Process all matches (API + Local)
  const allMatches = [...ltMatches, ...localMatches];

  for (const match of allMatches) {
    const mStart = match.offset;
    const mEnd = match.offset + match.length;
    const suggestionId = uid();

    for (const node of paragraphTextNodes) {
      const intersectStart = Math.max(mStart, node.start);
      const intersectEnd = Math.min(mEnd, node.end);

      if (intersectStart < intersectEnd) {
        suggestions.push({
          id: suggestionId,
          kind: "grammar",
          path: node.path,
          range: {
            anchor: { path: node.path, offset: intersectStart - node.start },
            focus: { path: node.path, offset: intersectEnd - node.start },
          },
          replacement: match.replacements[0]?.value || "",
          reason: match.message,
        });
      }
    }
  }

  // 2. Add POV propagation
  const targetPOV = selection && settings.povPropagation ? await inferTargetPOV(editor, paragraphPath, selection, apiKey) : null;
  if (targetPOV) {
    let povSuggestions: Suggestion[] = [];

    // Check if we can use "True" Coreference Resolution via Gemini
    if (apiKey) {
      povSuggestions = await getCorefSuggestionsFromGemini(paragraphText, paragraphTextNodes, targetPOV, apiKey);
    }

    // Fallback to heuristic if AI failed or no key
    if (povSuggestions.length === 0) {
      for (const node of paragraphTextNodes) {
        povSuggestions.push(...getPOVPropagationSuggestions(node.text, node.path, targetPOV));
      }
    }

    suggestions.push(...povSuggestions);
  }

  // Stable sort: earlier offsets first
  suggestions.sort((a, b) => {
    const ao = Range.start(a.range).offset;
    const bo = Range.start(b.range).offset;
    return ao - bo;
  });

  // Light de-dupe
  const seen = new Set<string>();
  return suggestions.filter((s) => {
    const key = `${s.path.join(",")}:${Range.start(s.range).offset}-${Range.end(s.range).offset}:${s.replacement}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function matchCase(desired: string, original: string) {
  if (original.toUpperCase() === original) return desired.toUpperCase();
  if (original[0]?.toUpperCase() === original[0]) return desired[0].toUpperCase() + desired.slice(1);
  return desired;
}

// -------------------- POV inference + propagation ------------------------

type POV = "he" | "she" | "they";

const PRONOUNS: Record<POV, { re: RegExp; map: Record<string, string> }> = {
  he: {
    // include: he, him, his
    re: /\b(he|him|his)\b/gi,
    map: {
      he: "he",
      him: "him",
      his: "his",
    },
  },
  she: {
    // include: she, her, hers
    re: /\b(she|her|hers)\b/gi,
    map: {
      she: "she",
      her: "her",
      hers: "hers",
    },
  },
  they: {
    // include: they, them, their, theirs (singular they)
    re: /\b(they|them|their|theirs)\b/gi,
    map: {
      they: "they",
      them: "them",
      their: "their",
      theirs: "theirs",
    },
  },
};

const POV_MAP: Record<POV, Record<string, string>> = {
  he: {
    // -> he
    she: "he",
    her: "him",
    hers: "his",
    they: "he",
    them: "him",
    their: "his",
    theirs: "his",
  },
  she: {
    // -> she
    he: "she",
    him: "her",
    his: "her",
    they: "she",
    them: "her",
    their: "her",
    theirs: "hers",
  },
  they: {
    // -> they
    he: "they",
    him: "them",
    his: "their",
    she: "they",
    her: "them", // note: ambiguous; demo only
    hers: "theirs",
  },
};

/**
 * Infer the "Target POV" by finding the pronoun OR name nearest to the cursor.
 */
async function inferTargetPOV(editor: Editor, paragraphPath: Path, selection: Range, apiKey?: string): Promise<POV | null> {
  const paragraphText = Node.string(Node.get(editor, paragraphPath));
  const cursor = selection.anchor;

  // Convert Slate point to absolute offset
  const paragraphTextNodes: Array<{ path: Path; text: string }> = [];
  for (const [n, p] of Node.texts(editor, { from: paragraphPath })) {
    paragraphTextNodes.push({ path: p, text: (n as Text).text });
  }

  let absolute = 0;
  for (const t of paragraphTextNodes) {
    if (Path.equals(t.path, cursor.path)) {
      absolute += cursor.offset;
      break;
    }
    absolute += t.text.length;
  }

  // 1. Check for a Name at the cursor (priority for Smart Inference)
  if (apiKey) {
    // Extract a small window around the cursor to find a potential name
    const windowStart = Math.max(0, absolute - 15);
    const windowEnd = Math.min(paragraphText.length, absolute + 15);
    const contextWindow = paragraphText.slice(windowStart, windowEnd);

    // Find capitalized words in the window
    const nameMatch = contextWindow.match(/\b[A-Z][a-z]+\b/);
    if (nameMatch) {
      try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
        const name = nameMatch[0];

        const prompt = `
          Context: "${paragraphText}"
          The user is currently editing the name "${name}". 
          In the context of this writing, what is the most likely POV / pronoun set for this character?
          Return ONLY one of: he, she, they.
          If it is unclear or not a character, return "unknown".
        `;

        const result = await model.generateContent(prompt);
        const pov = result.response.text().trim().toLowerCase();
        if (["he", "she", "they"].includes(pov)) {
          return pov as POV;
        }
      } catch (e) {
        console.error("AI POV inference failed:", e);
      }
    }
  }

  // 2. Fallback to nearest pronoun heuristic
  const allRe = /\b(he|him|his|she|her|hers|they|them|their|theirs)\b/gi;
  let nearestPOV: POV | null = null;
  let minDistance = Infinity;

  for (const m of paragraphText.matchAll(allRe)) {
    const start = m.index ?? 0;
    const token = m[0];
    const end = start + token.length;

    const distance = absolute < start ? start - absolute : absolute > end ? absolute - end : 0;

    if (distance < minDistance) {
      minDistance = distance;
      const lower = token.toLowerCase();
      for (const pov of Object.keys(PRONOUNS) as POV[]) {
        if (PRONOUNS[pov].map[lower]) {
          nearestPOV = pov;
          break;
        }
      }
    }
  }

  return nearestPOV;
}

function getPOVPropagationSuggestions(text: string, path: Path, target: POV): Suggestion[] {
  const suggestions: Suggestion[] = [];

  // Find any non-target gendered pronouns and propose a replacement.
  // We'll look for all pronouns across all sets, then map to target.
  const allRe = /\b(he|him|his|she|her|hers|they|them|their|theirs)\b/gi;

  for (const m of text.matchAll(allRe)) {
    const start = m.index ?? 0;
    const token = m[0];
    const lower = token.toLowerCase();

    // If it's already in the target set, skip.
    if (PRONOUNS[target].map[lower]) continue;

    const mapped = POV_MAP[target][lower];
    if (!mapped) continue;

    suggestions.push({
      id: uid(),
      kind: "pov-pronoun-propagation",
      path,
      range: {
        anchor: { path, offset: start },
        focus: { path, offset: start + token.length },
      },
      replacement: matchTokenCase(mapped, token),
      reason: `Align pronouns to ${target} POV (demo heuristic).`,
    });
  }

  return suggestions;
}

async function getCorefSuggestionsFromGemini(
  text: string,
  nodes: Array<{ path: Path; text: string; start: number; end: number }>,
  targetPOV: POV,
  apiKey: string
): Promise<Suggestion[]> {
  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: "gemini-3-flash-preview" });

    const prompt = `
      You are a Coreference Resolution engine for a creative writing tool.
      Text: "${text}"
      The user is writing about a character they want to use "${targetPOV}" pronouns for.
      
      Identify every pronoun in the text that refers to THIS SPECIFIC CHARACTER and should be aligned to "${targetPOV}". 
      Ignore pronouns that refer to DIFFERENT characters, even if they currently match the same gender.
      
      Return ONLY a JSON array of objects:
      [
        { "offset": number, "length": number, "original": "string", "replacement": "the ${targetPOV} version" }
      ]
    `;

    const result = await model.generateContent(prompt);
    const responseText = result.response.text();
    const cleaned = responseText.replace(/```json|```/g, "").trim();
    const matches = JSON.parse(cleaned);

    const suggestions: Suggestion[] = [];
    for (const match of matches) {
      const mStart = match.offset;
      const mEnd = match.offset + match.length;
      const suggestionId = uid();

      for (const node of nodes) {
        const iStart = Math.max(mStart, node.start);
        const iEnd = Math.min(mEnd, node.end);
        if (iStart < iEnd) {
          suggestions.push({
            id: suggestionId,
            kind: "pov-pronoun-propagation",
            path: node.path,
            range: {
              anchor: { path: node.path, offset: iStart - node.start },
              focus: { path: node.path, offset: iEnd - node.start },
            },
            replacement: matchTokenCase(match.replacement, match.original),
            reason: `AI detected this pronoun belongs to the character you're rewriting as ${targetPOV}.`,
          });
        }
      }
    }
    return suggestions;
  } catch (e) {
    console.error("Gemini Coref failed:", e);
    return [];
  }
}

function matchTokenCase(replacement: string, originalToken: string) {
  // Preserve capitalization for sentence-start tokens.
  if (originalToken[0] === originalToken[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

// ------------------- Slate leaf rendering (decorations) ------------------

type DecoratedText = Text & {
  suggestionId?: string;
  suggestionKind?: SuggestionKind;
};

function Leaf({ attributes, children, leaf }: RenderLeafProps) {
  const l = leaf as DecoratedText;

  if (l.suggestionId) {
    const kind = l.suggestionKind;
    const isPOV = kind === "pov-pronoun-propagation";

    const style: React.CSSProperties = {
      textDecoration: "underline",
      textDecorationStyle: isPOV ? "dashed" : "wavy",
      textDecorationColor: isPOV ? "#13c2c2" : "#ff4d4f",
      cursor: "pointer",
    };

    return (
      <span {...attributes} style={style} data-suggestion-kind={kind} title={`Suggestion: ${kind}`}>
        {children}
      </span>
    );
  }

  return <span {...attributes}>{children}</span>;
}

// ------------------------------ App --------------------------------------

export default function App() {
  const editor = useMemo(() => withHistory(withReact(createEditor() as ReactEditor)), []);
  const [value, setValue] = useState<Descendant[]>(initialValue);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [povSuggestions, setPovSuggestions] = useState<Suggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [customRules, setCustomRules] = useState<CustomRule[]>([]);
  const [ruleIntent, setRuleIntent] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [apiKey, setApiKey] = useState(import.meta.env.VITE_GEMINI_API_KEY || "");
  const [ruleSettings, setRuleSettings] = useState({
    ltTypos: true,
    ltGrammar: true,
    ltStyle: true,
    ltPunctuation: true,
    povPropagation: true,
    localFallbacks: true,
  });

  // Keep a tiny debounce so it doesn't recompute on every single keystroke.
  const debounceRef = useRef<number | null>(null);

  const recomputeSuggestions = useCallback(async () => {
    const { selection } = editor;
    if (!selection) {
      setSuggestions([]);
      setPovSuggestions([]);
      return;
    }

    const paragraphEntry = Editor.above(editor, {
      at: selection,
      match: (n) => isParagraph(n),
    });

    if (!paragraphEntry) {
      setSuggestions([]);
      setPovSuggestions([]);
      return;
    }

    setLoading(true);
    try {
      const [, paragraphPath] = paragraphEntry;
      const all = await getSuggestionsForParagraph(editor, paragraphPath, selection, customRules, ruleSettings, apiKey);

      // Gate POV suggestions: Separate from immediate underlines
      const immediate = all.filter(s => s.kind !== "pov-pronoun-propagation");
      const gated = all.filter(s => s.kind === "pov-pronoun-propagation");

      setSuggestions(immediate);
      setPovSuggestions(gated);
    } finally {
      setLoading(false);
    }
  }, [editor, customRules, ruleSettings, apiKey]);

  const scheduleRecompute = useCallback(() => {
    if (debounceRef.current) window.clearTimeout(debounceRef.current);
    debounceRef.current = window.setTimeout(async () => {
      await recomputeSuggestions();
    }, 400); // Slightly longer debounce for API calls
  }, [recomputeSuggestions]);

  const decorate = useCallback(
    ([node, path]: [any, Path]) => {
      const ranges: Range[] = [];
      if (!Text.isText(node)) return ranges;

      const all = [...suggestions, ...povSuggestions];

      for (const s of all) {
        if (Path.equals(s.path, path)) {
          ranges.push({
            ...s.range,
            suggestionId: s.id,
            suggestionKind: s.kind,
          } as any);
        }
      }
      return ranges;
    },
    [suggestions, povSuggestions]
  );

  const applySuggestion = useCallback(
    (s: Suggestion) => {
      Editor.withoutNormalizing(editor, () => {
        Transforms.select(editor, s.range);
        Transforms.insertText(editor, s.replacement, { at: s.range });
      });
      recomputeSuggestions();
    },
    [editor, recomputeSuggestions]
  );

  const applyAllPOVSuggestions = useCallback(() => {
    if (povSuggestions.length === 0) return;

    Editor.withoutNormalizing(editor, () => {
      const sorted = [...povSuggestions].sort((a, b) => {
        const pathCompare = Path.compare(a.path, b.path);
        if (pathCompare !== 0) return -pathCompare;
        return b.range.anchor.offset - a.range.anchor.offset;
      });

      for (const s of sorted) {
        Transforms.insertText(editor, s.replacement, { at: s.range });
      }
    });
    recomputeSuggestions();
  }, [editor, povSuggestions, recomputeSuggestions]);

  const getSuggestionAtCursor = useCallback((): Suggestion | null => {
    const { selection } = editor;
    if (!selection || !Range.isCollapsed(selection)) return null;

    const point = selection.anchor;

    // Prefer suggestions in the same text node as cursor; nearest forward, else nearest backward.
    let after: { s: Suggestion; dist: number } | null = null;
    let before: { s: Suggestion; dist: number } | null = null;

    const all = [...suggestions, ...povSuggestions];

    for (const s of all) {
      if (!Path.equals(s.path, point.path)) continue;
      const start = Range.start(s.range);
      const dist = start.offset - point.offset;
      if (dist >= 0) {
        if (!after || dist < after.dist) after = { s, dist };
      } else {
        const bdist = Math.abs(dist);
        if (!before || bdist < before.dist) before = { s, dist: bdist };
      }
    }

    return after?.s ?? before?.s ?? null;
  }, [editor, suggestions, povSuggestions]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Apply suggestion with Tab (only when we have one near the cursor).
      if (e.key === "Tab" && !e.shiftKey) {
        const s = getSuggestionAtCursor();
        if (s) {
          e.preventDefault();
          applySuggestion(s);
          return;
        }
      }

      // Shift+Tab = skip: move caret to end of the nearest suggestion.
      if (e.key === "Tab" && e.shiftKey) {
        const s = getSuggestionAtCursor();
        if (s) {
          e.preventDefault();
          const end = Range.end(s.range);
          Transforms.select(editor, { anchor: end, focus: end });
          return;
        }
      }
    },
    [applySuggestion, editor, getSuggestionAtCursor]
  );

  const handleAddRule = async () => {
    if (!ruleIntent.trim()) return;
    setIsGenerating(true);

    try {
      let newRule: CustomRule;

      if (apiKey) {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
          You are a LanguageTool Rule Specialist. 
          Convert the following user intent into a structured JSON rule for a custom grammar checker.
          The user wants to: "${ruleIntent}"
          
          Return ONLY a JSON object with this structure:
          {
            "pattern": "A JavaScript-ready Regex string (as a string literal, handle escapes carefully) that matches the error",
            "message": "The human readable explanation of the error",
            "replacement": "The suggested replacement word (optional)",
            "xml": "The LanguageTool XML <rule> format for this pattern"
          }

          Rules for Regex:
          - Use \\\\b for word boundaries (double escape for JSON string).
          - The regex should match the ERROR, not the correction.
          
          Rules for XML:
          - Use <rule>, <pattern>, <token>, <message>, <suggestion> tags.
          - Example: <rule id="ID" name="NAME"><pattern><token>word</token></pattern><message>Reason</message><suggestion>better</suggestion></rule>
        `;

        const result = await model.generateContent(prompt);
        const text = result.response.text();
        const cleaned = text.replace(/```json|```/g, "").trim();
        const parsed = JSON.parse(cleaned);

        newRule = {
          id: uid(),
          intent: ruleIntent,
          pattern: parsed.pattern,
          message: parsed.message,
          replacement: parsed.replacement || "",
          xml: parsed.xml
        };
      } else {
        // Fallback to simple regex if no API key
        await new Promise((r) => setTimeout(r, 600));
        let generatedPattern = "";
        let message = "";
        let replacement = "";

        const lower = ruleIntent.toLowerCase();
        if (lower.includes("avoid") || lower.includes("never use") || lower.includes("ban")) {
          const match = ruleIntent.match(/(?:avoid|use|ban)\W+(['"])?(\w+)\1/i) || ruleIntent.match(/(?:avoid|use|ban)\W+(\w+)/i);
          const word = match ? match[2] || match[1] : "word";
          generatedPattern = `\\b${word}\\b`;
          message = `Style Guide: Avoid using the word "${word}".`;
        } else if (lower.includes("replace") || lower.includes("instead of")) {
          const words = ruleIntent.match(/replace\s+(\w+)\s+with\s+(\w+)/i);
          if (words) {
            generatedPattern = `\\b${words[1]}\\b`;
            message = `Style Guide: Use "${words[2]}" instead of "${words[1]}".`;
            replacement = words[2];
          } else {
            generatedPattern = `\\bword\\b`;
            message = "Custom style rule triggered.";
          }
        } else {
          generatedPattern = `\\b${ruleIntent.split(" ").pop()}\\b`;
          message = `Custom Rule: ${ruleIntent}`;
        }

        newRule = {
          id: uid(),
          intent: ruleIntent,
          pattern: generatedPattern,
          message,
          replacement,
        };
      }

      setCustomRules((prev) => [...prev, newRule]);
      setRuleIntent("");
    } catch (error) {
      console.error("Failed to generate rule:", error);
      alert("Error generating rule. Please check your API key or intent.");
    } finally {
      setIsGenerating(false);
      recomputeSuggestions();
    }
  };

  const removeRule = (id: string) => {
    setCustomRules(prev => prev.filter(r => r.id !== id));
    recomputeSuggestions();
  };

  const renderLeaf = useCallback((props: RenderLeafProps) => <Leaf {...props} />, []);

  return (
    <div style={{ maxWidth: 980, margin: "40px auto", padding: 16, fontFamily: "system-ui" }}>
      <h2 style={{ marginBottom: 8 }}>Slate “Tab to Apply” Suggestions Demo</h2>
      <p style={{ marginTop: 0, opacity: 0.75 }}>
        Cheap, deterministic rules + a simple POV/pronoun propagation example. Press <b>Tab</b> to apply the nearest
        suggestion; <b>Shift+Tab</b> to skip.
      </p>

      <div style={{ border: "1px solid #ddd", borderRadius: 12, padding: 14 }}>
        <Slate
          editor={editor}
          initialValue={initialValue}
          onChange={(next) => {
            // Debounce the state update for the debug view to avoid lag
            if (debounceRef.current) window.clearTimeout(debounceRef.current);
            debounceRef.current = window.setTimeout(async () => {
              setValue(next);
              await recomputeSuggestions();
            }, 400);
          }}
        >
          <Editable
            decorate={decorate}
            renderLeaf={renderLeaf}
            onKeyDown={onKeyDown}
            onSelect={scheduleRecompute}
            placeholder="Start writing…"
            style={{ minHeight: 170, outline: "none", lineHeight: 1.55, fontSize: 16 }}
          />
        </Slate>
      </div>

      {povSuggestions.length > 0 && (
        <div style={{
          marginTop: 12,
          padding: "10px 16px",
          background: "#e6fffb",
          border: "1px solid #87e8de",
          borderRadius: 8,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          animation: "fadeIn 0.3s ease-out"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 18 }}>✨</span>
            <span style={{ fontSize: 14, color: "#006d75" }}>
              <b>POV Shift Detected:</b> Alignment issues found with {povSuggestions.length} pronouns in this paragraph.
            </span>
          </div>
          <button
            onClick={applyAllPOVSuggestions}
            style={{
              background: "#13c2c2",
              color: "white",
              border: "none",
              padding: "6px 14px",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
              fontWeight: "600"
            }}
          >
            Align Paragraph
          </button>
        </div>
      )}

      <div style={{ marginTop: 14 }}>
        <b>Suggestions</b> <span style={{ opacity: 0.65 }}>({suggestions.length})</span>
        {loading && <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.5 }}>Checking grammar…</span>}
        <div style={{ marginTop: 8, display: "grid", gap: 8 }}>
          {suggestions.slice(0, 10).map((s) => (
            <div
              key={s.id}
              style={{
                border: "1px solid #eee",
                borderRadius: 12,
                padding: 10,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <button
                onClick={() => applySuggestion(s)}
                style={{
                  border: "1px solid #ddd",
                  borderRadius: 10,
                  padding: "6px 10px",
                  cursor: "pointer",
                  background: "white",
                }}
              >
                Apply ↹
              </button>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, opacity: 0.7 }}>{s.kind}</div>
                <div>{s.reason}</div>
                <div style={{ fontSize: 13, opacity: 0.7 }}>
                  Replace with: <code>{JSON.stringify(s.replacement)}</code>
                </div>
              </div>
            </div>
          ))}
          {suggestions.length === 0 && <div style={{ opacity: 0.7 }}>No suggestions for the current paragraph.</div>}
        </div>
      </div>

      <div style={{ marginTop: 24, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        <div style={{ padding: 16, background: "#f0f2f5", borderRadius: 12, border: "1px solid #e8e8e8" }}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>Core Rule Settings</h3>
          <div style={{ display: "grid", gap: 10 }}>
            <SettingToggle
              label="Standard Typos"
              tooltip="Spelling mistakes and common typos detected by LanguageTool."
              checked={ruleSettings.ltTypos}
              onChange={() => setRuleSettings(s => ({ ...s, ltTypos: !s.ltTypos }))}
            />
            <SettingToggle
              label="Standard Grammar"
              tooltip="Grammatical errors like subject-verb agreement, mismatched tenses, and article usage."
              checked={ruleSettings.ltGrammar}
              onChange={() => setRuleSettings(s => ({ ...s, ltGrammar: !s.ltGrammar }))}
            />
            <SettingToggle
              label="Sentence Style"
              tooltip="Suggestions for clarity, avoiding redundancy, and improving active voice."
              checked={ruleSettings.ltStyle}
              onChange={() => setRuleSettings(s => ({ ...s, ltStyle: !s.ltStyle }))}
            />
            <SettingToggle
              label="Punctuation"
              tooltip="Oxford commas, mismatched brackets/quotes, and spacing issues."
              checked={ruleSettings.ltPunctuation}
              onChange={() => setRuleSettings(s => ({ ...s, ltPunctuation: !s.ltPunctuation }))}
            />
            <div style={{ margin: "8px 0", borderTop: "1px solid #ddd" }} />
            <SettingToggle
              label="POV Propagation"
              tooltip="Aligns pronouns in the paragraph to match the pronoun nearest your cursor (Local Engine)."
              checked={ruleSettings.povPropagation}
              onChange={() => setRuleSettings(s => ({ ...s, povPropagation: !s.povPropagation }))}
            />
            <SettingToggle
              label="Language Fallbacks"
              tooltip="Custom rules for subtle errors like 'It were' that the public API might skip (Local Engine)."
              checked={ruleSettings.localFallbacks}
              onChange={() => setRuleSettings(s => ({ ...s, localFallbacks: !s.localFallbacks }))}
            />
          </div>
        </div>

        <div style={{ padding: 16, background: "#f9f9f9", borderRadius: 12, border: "1px solid #eee" }}>
          <h3 style={{ marginTop: 0, fontSize: 16 }}>AI Style Guide Generator</h3>
          <p style={{ fontSize: 13, opacity: 0.7, marginBottom: 12 }}>
            Describe a custom rule (e.g., "Avoid 'actually'").
            {!apiKey && <span style={{ color: "#d48806" }}> (Add API Key for AI generation)</span>}
          </p>

          <div style={{ marginBottom: 12 }}>
            <input
              type="password"
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="Gemini API Key..."
              style={{ width: "100%", padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd", fontSize: 12, boxSizing: "border-box" }}
            />
          </div>

          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <input
              value={ruleIntent}
              onChange={e => setRuleIntent(e.target.value)}
              placeholder="Describe your rule..."
              style={{ flex: 1, padding: "8px 12px", borderRadius: 8, border: "1px solid #ddd" }}
            />
            <button
              onClick={handleAddRule}
              disabled={isGenerating}
              style={{
                padding: "8px 16px",
                borderRadius: 8,
                border: "none",
                background: "#13c2c2",
                color: "white",
                cursor: isGenerating ? "not-allowed" : "pointer"
              }}
            >
              {isGenerating ? "Gen" : "Add"}
            </button>
          </div>

          {customRules.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, fontWeight: "bold", opacity: 0.5 }}>ACTIVE CUSTOM RULES</div>
              {customRules.map(rule => (
                <div key={rule.id} style={{
                  background: "white",
                  border: "1px solid #ddd",
                  borderRadius: 8,
                  padding: "8px",
                  fontSize: 12,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontWeight: "bold" }}>{rule.intent}</span>
                    <button
                      onClick={() => removeRule(rule.id)}
                      style={{ border: "none", background: "none", cursor: "pointer", opacity: 0.5 }}
                    >×</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <details style={{ marginTop: 24 }}>
        <summary>Current Slate value (debug)</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(value, null, 2)}</pre>
      </details>
    </div>
  );
}

function SettingToggle({
  label,
  tooltip,
  checked,
  onChange
}: {
  label: string;
  tooltip?: string;
  checked: boolean;
  onChange: () => void
}) {
  return (
    <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", cursor: "pointer", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span>{label}</span>
        {tooltip && (
          <span
            title={tooltip}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 14,
              height: 14,
              borderRadius: "50%",
              background: "#ddd",
              color: "#666",
              fontSize: 10,
              fontWeight: "bold",
              fontStyle: "italic",
              cursor: "help"
            }}
          >
            i
          </span>
        )}
      </div>
      <input type="checkbox" checked={checked} onChange={onChange} style={{ cursor: "pointer" }} />
    </label>
  );
}
