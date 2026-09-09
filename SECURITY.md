# Security Policy

## Supported versions

Security fixes are released for the latest version published on the VS Code Marketplace. Earlier versions do not receive separate security fixes, so update the extension before reporting a problem.

| Version | Security support |
| --- | --- |
| Latest published version | Supported |
| Earlier versions | Unsupported |

## Report a vulnerability

Report vulnerabilities through [GitHub private vulnerability reporting](https://github.com/shayanline/devin-vscode/security/advisories/new). This route shares the report privately with the maintainer and supports coordinated disclosure.

Do not disclose vulnerability details in a public issue, pull request, Marketplace review, or Marketplace question.

Include the following information when possible:

- State the affected extension, VS Code, Devin CLI, and operating system versions.
- Describe the vulnerability, its security impact, and the conditions required to trigger it.
- Provide concise reproduction steps or a minimal demonstration.
- Include relevant logs after removing credentials, tokens, private code, personal information, and customer data.
- Suggest a mitigation if you have already identified one.

The maintainer will investigate the report and coordinate disclosure after affected users have a reasonable opportunity to update.

## Relevant extension vulnerabilities

Security reports for this repository include:

- An action that bypasses the permission choice shown to the user.
- Unexpected command execution or file access outside the scope the user approved.
- Script injection or unsafe content execution in a webview.
- Path handling that exposes or overwrites files outside the intended workspace.
- Exposure of credentials, MCP configuration, prompts, attachments, diagnostics, or stored file contents.

## Devin CLI vulnerabilities

This repository maintains the VS Code extension that hosts Devin CLI. Report a vulnerability that also occurs when using Devin CLI without this extension through [Cognition security guidance](https://docs.devin.ai/admin/security).
