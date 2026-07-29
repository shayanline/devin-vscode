# 03, Context and input (the composer)

Copilot's composer is the native chat input, which brings a rich `#` context
picker, `@` participant picker, `/` command picker, drag and drop, paste,
images, and voice. We rebuilt a composer in the webview with `/` and `@`
autocompletes and manual attachments.

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| `/` slash command autocomplete | Native picker of participant commands | Custom dropdown from ACP `available_commands_update` (built ins + all skills); sends `/name` | ✅ | Good parity. Could show the command `input.hint`. |
| `@` context: files | Native `#file` picker with fuzzy search + previews | Custom `@` dropdown querying workspace files | ✅ | Parity for files. |
| `#` context variables (selection, editor, terminalLastCommand, problems, changes, codebase, etc.) | Native, many typed context providers | Only file + current selection + image | 🟡 | Add richer context types: active editor, selection (have), open editors, problems/diagnostics, terminal selection/last command, git changes, whole folder, "codebase". Several map to ACP resource blocks or Devin tools. |
| Implicit/current file context | Native "current file" pill auto attached | ❌ (must attach manually) | 🟡 | Auto attach the active editor/selection as an optional, removable pill. |
| `@` participants (agents) | Native (`@workspace`, `@vscode`, `@terminal`, custom) | ➖ | ➖ | Devin is a single agent; not applicable, though skills partly fill this. |
| Attach via button | Native paperclip with a typed menu | Attach button opens a native QuickPick (selection/file/browse) | ✅ | Parity; could make it a richer menu. |
| Attachments shown as removable chips | Native chips | Chips with icon + remove | ✅ | Parity. |
| Image attach (paste) | Native, `imageUpload.enabled` | Paste image → base64 → ACP image block | ✅ | Parity (Devin advertises image prompt capability). |
| Image attach (drag and drop / from file) | Native drag and drop and file picker | ❌ (paste only) | 🟡 | Add drag and drop onto the composer and image files via the attach menu. |
| Drag and drop files/folders as context | Native | ❌ | ❌ | Add DnD of editor tabs / explorer items into the composer. |
| Paste file path / URL as context | Native (URL becomes fetchable context) | ❌ | 🟡 | Detect pasted paths/URLs and offer to attach. |
| Multiline input, Shift+Enter | Native | ✅ | ✅ | Parity. |
| Submit on Enter | Native | ✅ | ✅ | Parity. |
| Mode picker in composer | Native dropdown (Ask/Edit/Agent + custom) | Custom dropdown (Code/Ask/Plan/Bypass) | ✅ | See `06-models-modes.md` for semantics. |
| Model picker in composer | Native dropdown | Custom dropdown from ACP config options | ✅ | Parity. |
| Voice input (speech to text) | Native (VS Code Speech) | ❌ | ➖ | Requires the Speech extension; low priority. |
| Input history (up arrow recalls prior prompts) | Native | ❌ | 🟡 | Easy win: recall previous prompts with Up when input empty. |
| Token/context budget indicator near input | Native context bar | We show a "% context" in the header status | 🟡 | Move to a clearer context meter with a compact action. |
| Attach "problems"/diagnostics | Native `#problems` | ❌ | 🟡 | Map to a resource block or the Devin problems tool. |
| Attach terminal last command / selection | Native | ❌ | 🟡 | Useful; map to text context block. |
| Prompt/instructions files attach | Native (`.prompt.md`, `.instructions.md`) | ➖ (see `07-customization.md`) | ➖ | Covered under customization. |
