# 06, Models and modes

| Feature | Copilot Chat | Devin (current) | Status | Notes / effort |
|---|---|---|---|---|
| Model picker | Native dropdown, grouped, shows current | Custom dropdown built from ACP config options (full Devin model list with display names) | ✅ | Parity. Could group by family and mark image capable models. |
| Reasoning effort selection | Some models expose effort; Copilot has model variants | Devin exposes variants (e.g. medium/high) inside the model list | ✅ | Parity via the model list. |
| Mode picker | Native: Ask, Edit, Agent, plus user defined custom modes | Custom dropdown: Code (accept-edits), Ask, Plan, Bypass | 🟡 | Semantics differ (see below). We map to Devin's ACP modes. Missing: user defined **custom modes** (see `07`). |
| Per mode default model | Native (custom modes can pin a model) | `devin.defaultModel` global/workspace | 🟡 | No per mode model binding. |
| Show current model + mode at a glance | Native in composer + status | In composer dropdowns + status bar item | ✅ | Parity. |
| Switch model mid conversation | Native | ACP `set_config_option` for model | ✅ | Parity. |
| Rate limit auto switch to a fallback model | Native (`rateLimitAutoSwitchToAuto`) | ➖ | ➖ | Handled agent side by Devin's Adaptive. |
| BYOK: bring your own model provider (Anthropic, OpenAI, Gemini, xAI, OpenRouter, Ollama, Azure, OpenAI compatible) | Native, 11 `languageModelChatProviders` | ➖ | ➖ | Devin manages models/keys itself; not applicable to our extension. |

## Mode semantics: Copilot vs Devin

Copilot modes:

- **Ask**: answer questions, propose code, no automatic edits.
- **Edit**: multi file edits within a working set, user reviews.
- **Agent**: autonomous, tools + terminal + edits in a loop.
- **Custom modes**: user defined, with a curated tool set, model, and
  instructions.

Devin modes (as exposed over ACP):

- **Code** (`accept-edits`): write/edit code, auto approve edits in the
  workspace.
- **Ask**: answer without code changes (read only tools).
- **Plan**: plan first, read only.
- **Bypass**: auto approve all tool calls.

These do not line up one to one. Copilot's split is about *what the agent may
do*; Devin's is about *how much to auto approve* plus a plan/ask profile. This
is fine to keep, but two gaps stand out:

- No **custom modes** (curated tool set + model + instructions per mode). See
  `07-customization.md`.
- Mode labels/descriptions could be surfaced with tooltips so users understand
  Bypass vs Code, mirroring Copilot's mode descriptions.
