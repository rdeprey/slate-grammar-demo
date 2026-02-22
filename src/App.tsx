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

// ------------------------- Grammar engine (Hybrid) ----------------------------

async function getSuggestionsFromLT(text: string, language = "en-US"): Promise<any[]> {
  try {
    const params = new URLSearchParams();
    params.append("text", text);
    params.append("language", language);

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
  selection: Range | null
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];
  const paragraphText = Node.string(Node.get(editor, paragraphPath));
  if (!paragraphText.trim()) return [];

  // 1. Fetch from LanguageTool
  const ltMatches = await getSuggestionsFromLT(paragraphText);

  // Map Slate nodes to calculate absolute offsets (reusing our mapping logic)
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

  const findPathAndOffset = (absOffset: number): { path: Path; offset: number } | null => {
    for (const node of paragraphTextNodes) {
      if (absOffset >= node.start && absOffset <= node.end) {
        return { path: node.path, offset: absOffset - node.start };
      }
    }
    return null;
  };

  // Process LT matches
  for (const match of ltMatches) {
    if (match.replacements.length === 0) continue;

    const startPoint = findPathAndOffset(match.offset);
    const endPoint = findPathAndOffset(match.offset + match.length);

    if (startPoint && endPoint) {
      suggestions.push({
        id: uid(),
        kind: "grammar",
        path: startPoint.path,
        range: {
          anchor: startPoint,
          focus: endPoint,
        },
        replacement: match.replacements[0].value,
        reason: match.message,
      });
    }
  }

  // 2. Add local POV propagation (High priority for this demo)
  const targetPOV = selection ? inferTargetPOV(editor, paragraphPath, selection) : null;
  if (targetPOV) {
    for (const node of paragraphTextNodes) {
      suggestions.push(...getPOVPropagationSuggestions(node.text, node.path, targetPOV));
    }
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
 * Infer the "Target POV" by finding the pronoun nearest to the cursor.
 */
function inferTargetPOV(editor: Editor, paragraphPath: Path, selection: Range): POV | null {
  const paragraphText = Node.string(Node.get(editor, paragraphPath));
  const cursor = selection.anchor;

  // Convert Slate point to absolute offset in paragraph text
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

  const allRe = /\b(he|him|his|she|her|hers|they|them|their|theirs)\b/gi;
  let nearestPOV: POV | null = null;
  let minDistance = Infinity;

  for (const m of paragraphText.matchAll(allRe)) {
    const start = m.index ?? 0;
    const token = m[0];
    const end = start + token.length;

    // Distance calculation: 0 if cursor is inside/at boundaries of the token
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
    const kind = l.suggestionKind ?? "repeat-word";
    const style: React.CSSProperties = {
      textDecoration: "underline",
      textDecorationStyle: "wavy",
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

  // Keep a tiny debounce so it doesn't recompute on every single keystroke.
  const debounceRef = useRef<number | null>(null);

  const recomputeSuggestions = useCallback(async () => {
    const { selection } = editor;
    if (!selection) {
      setSuggestions([]);
      return;
    }

    const paragraphEntry = Editor.above(editor, {
      at: selection,
      match: (n) => isParagraph(n),
    });

    if (!paragraphEntry) {
      setSuggestions([]);
      return;
    }

    const [, paragraphPath] = paragraphEntry;
    const next = await getSuggestionsForParagraph(editor, paragraphPath, selection);
    setSuggestions(next);
  }, [editor]);

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

      for (const s of suggestions) {
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
    [suggestions]
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

  const getSuggestionAtCursor = useCallback((): Suggestion | null => {
    const { selection } = editor;
    if (!selection || !Range.isCollapsed(selection)) return null;

    const point = selection.anchor;

    // Prefer suggestions in the same text node as cursor; nearest forward, else nearest backward.
    let after: { s: Suggestion; dist: number } | null = null;
    let before: { s: Suggestion; dist: number } | null = null;

    for (const s of suggestions) {
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
  }, [editor, suggestions]);

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
            placeholder="Start writing…"
            style={{ minHeight: 170, outline: "none", lineHeight: 1.55, fontSize: 16 }}
          />
        </Slate>
      </div>

      <div style={{ marginTop: 14 }}>
        <b>Suggestions</b> <span style={{ opacity: 0.65 }}>({suggestions.length})</span>
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

      <details style={{ marginTop: 14 }}>
        <summary>Current Slate value (debug)</summary>
        <pre style={{ whiteSpace: "pre-wrap" }}>{JSON.stringify(value, null, 2)}</pre>
      </details>

      <p style={{ marginTop: 16, opacity: 0.7, fontSize: 13 }}>
        Note: POV propagation is a heuristic demo. In production, you’d heavily gate it (explicit user action, or
        high-confidence “POV change” detection) to avoid changing pronouns that refer to different characters.
      </p>
    </div>
  );
}
