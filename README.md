<div align="center">
  <img src="assets/whale-bridge-512.png" alt="Whale Bridge" width="180">

  <h1>Whale Bridge</h1>

  <p><strong>DeepSeek companion for working with local code projects.</strong></p>

  <p>
    A free and open-source Windows desktop application that puts the DeepSeek web interface
    next to your local project and turns AI code responses into reviewable, safe file changes.
  </p>
</div>

---

## What is Whale Bridge?

Whale Bridge is an Electron desktop application for developers who use the **DeepSeek web interface** while working on a local project.

It combines two things in one window:

- **DeepSeek on the left** — the normal web interface, including your existing account and chats.
- **Whale Bridge on the right** — your local project tree, prompt builder, proposed changes, Diff, history and rollback tools.

The important idea is simple: **DeepSeek suggests code, but Whale Bridge does not blindly write it to disk.**

The application parses supported code blocks from the DeepSeek page, matches them to your local files, shows the resulting Diff, and only applies the change after you confirm it.

### What it does

- Connects the DeepSeek web interface with a local project folder.
- Builds a structured first prompt from the selected project files.
- Copies selected files and their contents to the clipboard for quick context sharing.
- Detects full-file changes and partial `SEARCH / REPLACE` or `REPLACE_BLOCK` edits.
- Supports creating, updating, deleting and moving files through explicit proposals.
- Shows a Diff before a change is written.
- Checks the file on disk for conflicts using SHA-256 hashes.
- Creates backups and keeps an operation history.
- Supports rollback.
- Protects against unsafe paths, symlink escapes and several common malformed AI responses.
- Refuses to rewrite existing files when their encoding is not valid UTF-8 instead of silently corrupting them.

Whale Bridge **does not have its own AI model or backend**. It works with the DeepSeek web service already open in the application.

---

## Quick start — Windows

### Option 1: download a release

Download one of the Windows builds from the repository's **Releases** page:

- **Installer** — normal Windows installation with Start Menu / Desktop shortcuts.
- **Portable** — a standalone executable that does not require installation.

Launch Whale Bridge and sign in to DeepSeek in the left panel.

### Option 2: run from source

Requirements:

- Windows, Linux or macOS
- Node.js 20+
- npm

Then:

```bash
npm install
npm start
```

For Windows, `start.bat` can install dependencies and start the application for you.

For Linux/macOS:

```bash
./start.sh
```


---

## How to use it

### 1. Open DeepSeek

Start Whale Bridge and sign in to your DeepSeek account in the left-hand web view.

Whale Bridge does not create or manage your DeepSeek account. It simply displays the DeepSeek web interface inside the application.

### 2. Add your project

In the right panel, click **Добавить папку** and select the root folder of your project.

The selected project is associated with the current DeepSeek chat. The association is remembered locally so you can return to the same chat later.

### 3. Prepare the first prompt

Open the **Промпт** tab.

The prompt builder can include:

- the task;
- project context;
- selected files and folders;
- project structure;
- constraints;
- working rules;
- the desired working mode.

Select the files you want DeepSeek to see and click **Скопировать промпт**. Paste the generated prompt into DeepSeek yourself.

You can also use **Скопировать файлы** to put the selected files and their contents into the clipboard as one compact context block.

> Whale Bridge does **not** silently type into the DeepSeek message box or send messages on your behalf. You decide what gets pasted and sent.

### 4. Ask DeepSeek to modify the project

Ask DeepSeek to change the selected files according to the rules in the generated prompt.

Whale Bridge watches the rendered DeepSeek response. Supported code markers tell it which local file a code block belongs to.

For example:

```text
# &src/example.js
```

or for a new file:

```text
# &NEW:src/example.js
```

When the response is complete, the right panel creates a proposal.

### 5. Review the Diff

Open the proposal and inspect the Diff.

Nothing is written to the project just because DeepSeek generated code.

Click **Принять изменения** only when the result is correct.

### 6. Undo changes

Every applied operation is recorded in history and protected with a backup where applicable.

Use **↩ Откатить** next to a file or the **История** tab to inspect and roll back previous operations.

---

## Supported edit formats

### Full file

For a complete file, DeepSeek can return the file contents under its path marker:

```text
# &src/example.py
print("Hello")
```

For a new file:

```text
# &NEW:src/example.py
print("Hello")
```

### REPLACE_BLOCK

Use this for replacing a whole function, method or class without sending the entire file:

```text
# &src/example.py
<<<<<<< REPLACE_BLOCK
def main():
    print("new version")
>>>>>>> REPLACE_BLOCK
```

Whale Bridge finds the corresponding function/method/class in the current file and replaces that block.

### SEARCH / REPLACE

Use this for a small, precise edit:

```text
# &src/example.py
<<<<<<< SEARCH
old code
=======
new code
>>>>>>> REPLACE
```

The searched text must match exactly one place in the file. Ambiguous or missing matches are rejected instead of guessing.

### Delete a file

```text
# &DELETE:src/old_file.py
```

### Move a file

```text
# &MOVE:src/old_file.py -> src/new_file.py
```

Delete and move operations do not require the file contents to be rewritten.

---

## Safety model

Whale Bridge is intentionally conservative when applying AI-generated changes.

Before writing a file it checks, among other things:

- path traversal such as `..`;
- absolute paths;
- attempts to escape through symlinks;
- `.git` and other protected paths;
- valid operation type (`create`, `update`, `delete`, `move`);
- SHA-256 conflict between the file used to build the proposal and the current file on disk;
- incomplete or obviously truncated AI responses;
- ambiguous `SEARCH / REPLACE` matches;
- invalid UTF-8 when an existing file would be rewritten.

Writes use a backup + temporary-file + atomic-replacement flow where appropriate.

The goal is not to make AI-generated code automatically correct. The goal is to make **AI-assisted file changes reviewable and reversible**.

---

## Privacy and data flow

Whale Bridge has **no Whale Bridge server, account system or AI backend**.

The application works locally with the project folder and embeds the DeepSeek website. It does not need a Whale Bridge API key.

However, using DeepSeek is still using a third-party online service. If you paste project files, code, prompts or other information into DeepSeek, that information is sent to DeepSeek according to the service and account terms that apply to you.

Do not paste secrets, passwords, private keys, credentials or confidential data unless you are sure that doing so is appropriate.

Whale Bridge itself does not bypass DeepSeek authentication, CAPTCHA, access controls or other website protections.

---

## Project structure

```text
main.js              Electron main process, window, DeepSeek WebContentsView and privileged IPC
preload-chat.js      DOM observer inside the DeepSeek page; read-only extraction
preload-ui.js        restricted IPC bridge for the Whale Bridge UI

src/
  parser.js          response markers and edit-format detection
  patch.js           SEARCH / REPLACE parsing and application
  promptgen.js       prompt builder and project tree
  paths.js           project-path safety checks
  diff.js            Diff generation
  fileops.js         reading, writing, backups, rollback and file operations
  store.js           local configuration and history
  proposals.js       proposal lifecycle, validation and application

ui/
  app.js             right-hand application UI
  styles.css         Whale Bridge UI styling
  index.html         UI shell

tests/               automated logic and UI smoke tests
assets/              Whale Bridge application icons
```

---

## Building Windows releases

Whale Bridge uses `electron-builder` for Windows packaging.

Build both the installer and portable executable:

```bash
npm run build:win
```

Or build them separately:

```bash
npm run build:win:installer
npm run build:win:portable
```

The resulting artifacts are written to `release/`.

The project also contains a `build.bat` helper for Windows builds.

GitHub Actions can be used to build release artifacts from a version tag.

---

## Open source and license

**Whale Bridge is free and open-source software.**

The source code of Whale Bridge is released under the **MIT License**. See [`LICENSE`](LICENSE) for the full license text.

You are free to use, study, modify and redistribute the project in accordance with that license and the licenses of its third-party dependencies.

The downloadable Whale Bridge Windows builds are provided free of charge. There is no paid Whale Bridge subscription, activation key or proprietary Whale Bridge server required to run the application.

### Third-party software

Whale Bridge is built with open-source software including Electron and electron-builder. Their respective licenses and notices remain applicable to those components.

Whale Bridge is **not** a distribution of the DeepSeek software itself. It embeds and displays the DeepSeek web service in an Electron window.

---

## DeepSeek trademark and affiliation disclaimer

**Whale Bridge is an independent, unofficial third-party project.**

Whale Bridge is **not developed by, sponsored by, endorsed by, affiliated with, or officially connected to DeepSeek, Hangzhou DeepSeek Artificial Intelligence Co., Ltd., or any of its subsidiaries or services.**

“DeepSeek” is used in this README only to accurately describe the third-party web service with which Whale Bridge is designed to work. The DeepSeek name, logos, product names and other brand assets remain the property of their respective owners.

Whale Bridge does not claim ownership of the DeepSeek service, its website, its models, its trademarks or its proprietary content.

Use of the DeepSeek service through Whale Bridge remains subject to the terms, policies and requirements applicable to that service. Users are responsible for complying with those terms and with applicable law.

**Whale Bridge is simply an independent desktop companion that provides a local workspace around the DeepSeek web interface.**

---

## Disclaimer

Whale Bridge is provided **“as is”**, without warranties of any kind, to the extent permitted by applicable law.

AI-generated code can be incorrect, insecure, incomplete or incompatible with your project. Always review, test and validate changes before using them in production.

Whale Bridge does not guarantee the availability, accuracy, reliability or continued compatibility of the DeepSeek web service. Changes to the DeepSeek website may require changes to Whale Bridge's DOM observer and integration layer.

Nothing in this README is legal advice. If you need advice about licensing, trademarks, privacy, data protection or your particular use of DeepSeek, consult a qualified professional.

---

## If DeepSeek changes its web interface

The DOM integration depends on the rendered DeepSeek page. If DeepSeek changes its markup, some extraction features may stop working until the selectors are updated.

For debugging, use **Вид → DevTools чата (F12)**.

As a fallback, you can copy a DeepSeek response and use **Взять из буфера**.

---

## Known limitations

- No syntax highlighting or line-by-line partial acceptance yet.
- History is stored in JSON rather than SQLite.
- Some social-login flows may not work inside an embedded browser window.
- Whale Bridge does not bypass authentication, CAPTCHA or website security controls.
- Compatibility depends on changes to the DeepSeek web interface.

---

## License

MIT — see [`LICENSE`](LICENSE).
