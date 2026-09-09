# Devin for VS Code

[![VS Code Marketplace](https://badgen.net/vs-marketplace/v/shayanline.devin-vscode?label=Marketplace)](https://marketplace.visualstudio.com/items?itemName=shayanline.devin-vscode)
[![Latest release](https://img.shields.io/github/v/release/shayanline/devin-vscode?label=Release)](https://github.com/shayanline/devin-vscode/releases/latest)

Use [Devin CLI](https://docs.devin.ai/cli) as a coding assistant without leaving VS Code. Ask Devin to explain code, fix bugs, build features, run commands, or edit files from a native chat panel.

Each chat runs a real Devin CLI session in your workspace. Replies stream into the panel, tool calls wait for your approval, and file edits open as VS Code diffs that you can keep or undo. Sessions remain available after you restart VS Code.

> **Preview:** This independent open source extension is under active development. Features can change as the Devin CLI evolves.

## See it in action

<table>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/01-session-list.png" width="100%" alt="The session browser with sessions grouped by workspace folder and a status indicator on each session" /></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/02-refactor-and-tests.png" width="100%" alt="A refactoring request with grouped tool calls, a file edit, a plan, a question, and a permission request" /></td>
  </tr>
  <tr>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/03-fix-with-diff.png" width="100%" alt="A bug fix with reasoning, grouped tools, and an edit opened as a VS Code diff" /></td>
    <td width="50%"><img src="https://raw.githubusercontent.com/shayanline/devin-vscode/main/docs/screenshots/04-research-and-diagram.png" width="100%" alt="A research request with web and MCP tools plus a Mermaid diagram rendered in the reply" /></td>
  </tr>
</table>

## Before you start

Before installing the extension, confirm these requirements:

- Your computer has VS Code 1.93 or newer.
- The [Devin CLI](https://docs.devin.ai/cli) is installed on your computer.
- Your Devin account can sign in through the CLI.

## Install the extension

1. Install **Devin for VS Code** from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=shayanline.devin-vscode), or run:

   ```sh
   code --install-extension shayanline.devin-vscode
   ```

2. Install the [Devin CLI](https://docs.devin.ai/cli) if it is not already available.
3. Sign in from a terminal:

   ```sh
   devin auth login
   ```

4. Open a project in VS Code, then select the **Devin** icon in the Activity Bar.

The extension checks your CLI installation when the panel opens. If it cannot find the executable or your account is signed out, the setup screen will guide you through selecting the executable and signing in.

## Start your first chat

Type a request in the composer and press Enter. For example:

- `Explain how authentication works in this project.`
- `Fix the TypeScript errors in the active file.`
- `Add validation for empty email addresses and run the relevant tests.`

Devin can use the active file, your selected code, and diagnostics reported by VS Code as context. While it works, the panel shows its replies, tool activity, questions, command output, and file changes.

When Devin requests permission, review the proposed action before approving it. After Devin edits a file, open the diff to inspect the change, then choose **Keep** or **Undo**.

## Add project context

You can give Devin more precise context in several ways:

- Select code before sending your request. The active selection appears in the composer and can be removed for an individual message.
- Type `@` to attach a file or symbol from your workspace.
- Right click selected code and choose **Devin: Explain This**.
- Right click an editor and choose **Devin: Fix Problems Here** to include the diagnostics reported for that file.
- Right click a file and choose **Devin: Add File to Chat**.
- Drag files, folders, or images onto the chat. Hold Shift while dragging from the VS Code Explorer or an editor tab.
- Paste an image directly into the composer.

Type `/` to browse the commands and skills provided by your Devin CLI setup.

## Choose how Devin works

Select a model and mode from the chat composer. The available choices come from your installed Devin CLI, so they can change after a CLI update.

| Mode | Behaviour |
| --- | --- |
| **Code** | Devin can write and edit workspace files. Workspace edits are approved automatically. |
| **Smart** | Devin can approve actions that its safety check considers safe. |
| **Ask** | Devin answers questions without changing code. |
| **Plan** | Devin investigates and prepares a plan in read only mode. |
| **Bypass** | Devin approves every tool call automatically. Use this only when you trust the task and workspace. |

Permission requests can also offer approval for the current action, the session, the project, or every project. Review the scope before choosing a broader permission.

## Review changes and restore checkpoints

Each file edit appears in the conversation and in the Devin source control view. You can:

- Open the diff for an individual file.
- Keep or undo one file.
- Keep or undo all files changed by the current chat.
- Restore an earlier checkpoint to rewind the conversation and compatible file changes.
- Fork an earlier turn into a separate chat so you can try another approach while preserving the original conversation.

Checkpoint and fork controls appear when your Devin CLI supports them.

## Manage chats and sessions

Sessions are saved per workspace and remain available after VS Code restarts. Open **Devin: Session List** from the Command Palette to search sessions, filter by status, or return to an earlier chat.

Useful shortcuts include:

- `Cmd+K Cmd+D` on macOS, or `Ctrl+K Ctrl+D` on Windows and Linux, opens the session list when the editor is not focused.
- `Cmd+1` to `Cmd+9` on macOS, or `Ctrl+1` to `Ctrl+9` on Windows and Linux, opens one of the nine most recent sessions while the Devin chat is focused.

Use the `+` menu to start a chat in the sidebar, an editor tab, a new window, or a terminal. You can also move a running chat between the side panel and an editor tab without stopping it.

## Run commands

By default, commands run through the Devin CLI while their output streams into the chat. Enable `devin.useIntegratedTerminal` if you want commands to run in a visible VS Code terminal that you can open and take over. This option requires [VS Code shell integration](https://code.visualstudio.com/docs/terminal/shell-integration).

Long running commands can continue in the background while Devin works on the next step. Subagent work appears in a separate block, where supported by the CLI, and a running subagent can move between the foreground and background.

## Change settings

Run **Devin: Open Settings** from the Command Palette to manage the Devin CLI configuration in a built in editor. It supports instructions, skills, plugins, MCP servers, hooks, permissions, and other CLI options at machine or workspace scope. Changes are written to the CLI configuration that the `devin` command uses in your terminal.

To configure the extension itself, open VS Code Settings and search for `@ext:shayanline.devin-vscode`. Available options include session behaviour, editor context, reasoning display, checkpoints, command execution, and the CLI executable path.

## Data and privacy

The extension starts your installed Devin CLI on your computer and communicates with it through the Agent Client Protocol. The extension does not contain a separate telemetry or analytics client.

Prompts, selected code, attached files and images, editor diagnostics, tool responses, and other context you provide are passed to Devin CLI. The CLI can communicate with Cognition services and any MCP servers you configure. Their data handling depends on your Devin account, organization settings, deployment, and the services you connect. Review [Cognition security and privacy guidance](https://docs.devin.ai/admin/security) before using sensitive data.

The extension stores session identifiers, titles, cached session details, and unsent drafts in VS Code workspace storage. It can also store staged attachment contents and original file contents needed for pending **Keep** or **Undo** actions in VS Code extension storage. Devin CLI manages full conversation history, authentication, and its own configuration separately.

Remove secrets and unnecessary personal or customer data before attaching context. Review tool permissions and the data policies of configured MCP servers before approving access.

## Troubleshooting

### The extension cannot find the Devin CLI

Open the Command Palette and run **Devin: Run Setup**, then choose **Browse** to select the `devin` executable. You can also set an absolute executable path in `devin.cliPath`. Choose **Re-check** after changing the path.

### The extension says you are signed out

Select **Log in** on the setup screen, complete `devin auth login` in the terminal, then choose **Re-check**.

### A feature or control is missing

Some controls depend on capabilities reported by the installed Devin CLI. Update the CLI using the [official CLI instructions](https://docs.devin.ai/cli), then start a new chat.

### VS Code asks for a second command approval

VS Code can show its own terminal approval after Devin approves a command when `devin.useIntegratedTerminal` is enabled. Disable that setting if you prefer to use the Devin permission prompt on its own. See the [known issue and workaround](docs/known-issues.md) for details.

## Feedback and support

Read the [support guide](SUPPORT.md) for troubleshooting and the information to include in a report. Use the [GitHub issue tracker](https://github.com/shayanline/devin-vscode/issues) for extension problems and feature requests.

Report vulnerabilities privately by following the [security policy](SECURITY.md). Do not include security details, credentials, private code, personal information, or customer data in a public issue.

Contributions are welcome. Read the [contribution guide](CONTRIBUTING.md) before opening a pull request.

## License

[AGPL-3.0-or-later](https://www.gnu.org/licenses/agpl-3.0.html), copyright Shayan Khaksar. You may use, study, change, and share the extension. If you distribute a modified version or run one as a network service, it must remain under the same license with its source available.

Commercial licences are available if these terms do not suit your use case. [Open an issue](https://github.com/shayanline/devin-vscode/issues) to ask about them.
