# Slate Grammar Suggestions Demo

## Run
```bash
npm install
npm run dev
```

## What it demonstrates
- Rule-based inline suggestions in Slate (wavy underline)
- Press `Tab` to apply the nearest suggestion to the cursor
- Press `Shift+Tab` to skip

## Included rules
- repeated word ("the the")
- double spaces
- capitalization after `. ! ?`
- a/an heuristic
- POV / pronoun propagation (he/she/they) inferred from the sentence containing the cursor (demo heuristic)
