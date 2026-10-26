# Sidequest

**An AI voice tutor that sits on top of your game.** Say *"let's learn about X"*, keep
playing, and it teaches you out loud while it draws diagrams, tables, graphs and animated
scenes in a corner of your screen. Each drawing lands in sync with the sentence that explains
it. It's a real conversation with no push-to-talk: talk over it any time to ask a question,
and it quizzes you before moving on.

It works for any subject: a language, calculus, history, networking, a certification you're
studying for, how to run AI models locally, or the notes you drop on it.

![What the board looks like: a comparison with a real screenshot, a Spanish vocabulary table, a derivative plot and an animated attack diagram](docs/images/hero.png)

> Windows only. Sidequest runs on your own PC and uses **your own Claude account** (a Claude
> Pro/Max subscription or an Anthropic API key). Speech recognition and the voice run locally.

---

## What you get

| | |
|---|---|
| ![The tutor points at the row it's talking about](docs/images/pointing-at-a-row.png) | **It points at what it's saying.** A follow-along pointer and highlight move with the voice: the row, the step or the arrow it's on. Ask "which one?" or "zoom in on that" and it marks the exact thing. |
| ![Step-by-step follow-along](docs/images/follow-along.png) | **One drawing per sentence.** It never talks about something that isn't on the board yet. By default it buffers a few seconds so the visuals are ready before it speaks. |
| ![A course map for Spanish A1](docs/images/course-map.png) | **Courses on the spot.** "Let's learn Spanish" gets you a course map in seconds, and it starts teaching right away while a planner designs the full course in the background. For anything recent, it researches the web first. |
| ![An illustrated scene while the planner works](docs/images/illustrator-scene.png) | **Illustrated scenes.** For big ideas, a second "illustrator" session builds an animated scene and streams it onto the board piece by piece while the tutor keeps talking. |
| ![Hand-drawn marks: underline, box, circle, highlight, strike-through](docs/images/marks-and-cursor.png) | **Hand-drawn feel.** Sketchy strokes animate in. Real photos and screenshots appear when they help (from Wikipedia and Wikimedia Commons). Math renders with KaTeX and flowcharts with Mermaid, and the motion shows how things work. |
| ![The course index](docs/images/course-index.png) | **Index and progress.** Every section, its goal, what's done and what's next. Click to jump. Next time it resumes where you left off, and re-asks the questions you missed. |

Also included:

- **Your own material.** Drag in PDFs, notes or images, or paste a table of contents, and it
  teaches from that. It can also go page by page with your book ("page 12: TCP flags...").
- **"Look at my screen."** It takes a screenshot and talks about what you're seeing.
- **Lecture or Wait mode.** Lecture keeps teaching while you're quiet, and the next chunk is
  prepared while the current one plays. Wait answers, then waits for you.
- **Made for mid-game.** It's click-through and never steals focus. Everything works by voice
  or by a hotkey, and it docks to a corner or goes full screen.

---

## Requirements

- **Windows 10 or 11.**
- **A microphone.** Headphones are recommended, so it doesn't hear itself.
- **A Claude account:**
  - **Claude Pro or Max subscription.** Sidequest uses it through Claude Code, so it counts
    against your plan's normal usage limits with no extra bill.
  - **Or an Anthropic API key.** This is billed per use. A tutoring session sends a lot of
    text, so watch your usage in the
    [Anthropic Console](https://console.anthropic.com/).
- **[Python 3.11+](https://www.python.org/downloads/)** and **[Node.js 18+](https://nodejs.org/)**.
- **Disk space:** about 3 GB for Python packages, Electron and the speech models.
- **Optional: an NVIDIA GPU.** Speech recognition takes about 0.3 s on a GPU (about 1.5 GB of
  VRAM) instead of 1–2 s on the CPU. The voice always runs on the CPU.

## Install

```powershell
git clone https://github.com/AhmadKhalidSA/Sidequest.git
cd Sidequest
powershell -ExecutionPolicy Bypass -File setup.ps1
```

`setup.ps1` does these steps. It's safe to re-run, because finished steps are skipped.

1. Creates a Python virtual environment in `.venv` and installs `requirements.txt`. If it finds
   an NVIDIA GPU, it adds the CUDA libraries.
2. Runs `npm install` for the Electron overlay.
3. Downloads the Kokoro voice model (about 350 MB) into `models/`.
4. Tells you how to sign in to Claude (next section).

### Connect your Claude account

Do this once. Pick one option:

- **Subscription:** run the Claude Code CLI that ships inside the SDK, then sign in:
  ```powershell
  .venv\Lib\site-packages\claude_agent_sdk\_bundled\claude.exe
  ```
  Type `/login`, finish in the browser, then `/exit`. If you already use
  [Claude Code](https://claude.com/claude-code) and are signed in, you can skip this.
- **API key:** set it for your user account and open a new terminal:
  ```powershell
  setx ANTHROPIC_API_KEY "sk-ant-..."
  ```

## Run

1. Set your game to **Borderless Windowed**. A normal window can't draw over exclusive
   fullscreen.
2. Double-click **`start.bat`**. A panel appears in the top-right corner. The first launch
   takes about 30–40 s, because the speech models download from Hugging Face on first use.
3. **Just talk.** For example:
   - *"Let's learn about how vaccines work."*
   - *"Teach me the basics of Japanese."*
   - *"Explain what a GPU's VRAM is for."*

`demo.bat` replays a scripted lesson with no AI and no audio, so you can see the board and pick
a size and corner first.

---

## How to use it

### Talking to it

| Say | What happens |
|---|---|
| *"Let's learn about X"* / *"teach me X"* | Starts a new course on X. |
| Anything, any time | It stops mid-word and listens. "Yeah" or "okay" lets it carry on; a real question gets answered. |
| *"Pause"* / *"wait"* | Pauses the lesson. *"Continue"* picks it back up. |
| *"Lecture mode"* / *"wait mode"* | Switches whether it keeps going on its own. |
| *"Look at my screen"* | Screenshots your screen and talks about it. |
| *"Full screen"* / *"dock it"* | Fills the screen, or snaps back to its corner. |
| *"Which one?"* / *"zoom in on that"* | Highlights or zooms the exact thing on the board. |
| *"Stop listening"* | Mutes its ears. The lesson keeps going. |

### Keys and buttons

| Key | Button | What it does |
|---|---|---|
| **Mouse 5** | Mic | Mute or unmute its ears, for example during team voice chat. |
| **F7** | Lecture / Wait | Toggles the talk mode. |
| **F8** | | Gives the panel focus and opens the controls: course picker, Start, Quiz me, Repeat, Recap, Next section, Pause, a box to type questions, size, corner and opacity. Esc closes it. |
| **F9** | | Hides or shows the panel. |
| **F10** | ⤢ | Full screen. Press again to go back. |
| | Index | The course index. Click a section to jump there. |
| | Screen | Same as "look at my screen". |
| | Dock | Snaps the panel back to its corner. |
| | ⚙ | Settings. |

The buttons in the header can be clicked directly. Hotkeys are read by polling, not hooked,
so your game still receives them. Change any key in Settings if it clashes with your game.

### Your own material

Press F8, click **+ New**, and name a course. Then do either of these:

- **Index → Course outline:** paste the table of contents from your book or syllabus. Topic
  names are enough.
- **Drag files onto the panel:** PDF, Markdown, text or images. Convert .pptx or .docx to PDF
  first.

Then say *"let's start"*. A planner designs the course in the background (30–60 s) while the
tutor chats with you, then it teaches section by section, with a checkpoint question every few
chunks. **Re-plan** in the Index rethinks the course after you add more material.

Each course is a folder in `courses/` with plain files you can read or edit:

- `plan.json`: the sections, goals and checkpoint questions.
- `progress.json`: where you are, and your quiz score.
- `notes.md`: what you know, what you struggle with, and a review queue of missed questions.

---

## Settings

Open **⚙** in the panel, or copy `config.example.json` to `config.json` and edit it. Useful
ones:

| Key | Default | Notes |
|---|---|---|
| `brain.model` | `sonnet` | The tutor. `haiku` is faster and lighter on usage; `opus` explains better but is slower. |
| `brain.plannerModel` | `opus` | Designs the course once per plan, in the background. |
| `brain.directorModel` | `sonnet` | The illustrator that builds animated scenes. |
| `lesson.prebufferSeconds` | `8` | How far ahead it prepares speech and drawings before it starts talking. `0` starts faster but the board may lag. |
| `lesson.followAlong` | `true` | The pointer that tracks the current sentence. |
| `audio.endSilenceMs` | `1600` | How long a pause means you've finished. Raise it if it cuts you off. |
| `stt.model` / `stt.device` | `distil-large-v3` / `auto` | On a weak GPU, or to leave the GPU to your game, use `"model": "small.en", "device": "cpu"`. To speak in a language other than English, use `large-v3`. |
| `tts.voice` / `tts.speed` | `af_heart` / `1.0` | Any Kokoro voice: `am_adam`, `bf_emma`, `bm_george`... |
| `keys.*` | `MOUSE5`, `F7`–`F10` | Also `MOUSE4`, `MOUSE3`, `F1`–`F24`, letters, `INSERT`, `NUMPAD0`... |
| `mirror.enabled` | `false` | Serves the board to a phone, tablet or second monitor on your network. |
| `modelsDir` | `models/` | Where the Kokoro voice files live. |
| `python` | `.venv` | The Python that runs the engine. |

Audio follows the Windows default device: switch from headset to speakers and Sidequest
follows within about 2 seconds.

---

## How it works

```
mic ─► Silero VAD + Smart Turn ─► faster-whisper (local) ─► Claude tutor (streaming)
                                                               │
                         speech lines + @{board commands}, interleaved in one stream
                                                               ▼
        Kokoro voice (local) ─► player ─► each drawing fires as the voice reaches it ─► overlay
```

- **One stream for voice and board.** Claude writes speech with whiteboard commands on their
  own lines. The engine speaks the text and fires each command as the voice gets there, so
  speech and drawings can't drift apart. A lookahead buffer prepares the next few seconds,
  and in Lecture mode the next chunk, while the current one plays.
- **Three Claude sessions** run through the
  [Claude Agent SDK](https://docs.claude.com/en/docs/agent-sdk/overview):
  - the **tutor** talks with you and can search the web;
  - the **planner** designs the course in the background;
  - the **illustrator** builds animated scenes on request.

  Your Claude Code settings, plugins and connectors are not loaded into them.
- **Natural turn-taking.** Voice activity detection plus the
  [Smart Turn](https://github.com/pipecat-ai/smart-turn) model decide when you've finished a
  sentence, so there's no button to hold. Hums and "uh"s are ignored.
- **Board.** An Electron overlay renders a virtual whiteboard with
  [rough.js](https://roughjs.com/), [GSAP](https://gsap.com/), [KaTeX](https://katex.org/) and
  [Mermaid](https://mermaid.js.org/). It also places content without overlaps and keeps the
  camera framed on it.
- **Plain window.** The overlay is a separate transparent window. There's no injection into
  the game, no reading of game memory, and no input automation.

### Privacy

- **Stays on your PC:** your voice. Speech-to-text and text-to-speech run locally, and audio is
  never uploaded.
- **Goes to Anthropic:** what you say (as text), your course material, and screenshots you ask
  it to look at, all through your Claude account.
- **Goes to public image services:** short search words only, to Wikipedia, Wikimedia Commons,
  Openverse and Iconify, to find images and icons.
- **Never committed to git:** your `config.json`, `courses/`, `logs/` and `cache/` are in
  `.gitignore`.

---

## Troubleshooting

- **Nothing shows over the game:** the game is in exclusive fullscreen. Switch it to Borderless
  Windowed.
- **"Couldn't start Claude Code":** you're not signed in. Redo
  [Connect your Claude account](#connect-your-claude-account).
- **It doesn't hear you:** check that Windows isn't muting your mic, and that the header says
  *Mic on*.
- **It cuts you off mid-thought:** raise `audio.endSilenceMs` in Settings.
- **Speech recognition is slow:** without an NVIDIA GPU, set `stt.model` to `small.en`.
- **"Kokoro voice model not found":** run `setup.ps1` again; it downloads into `models/`.
- **Anything else:** right-click the tray icon, then **Open engine log** (`logs/engine.log`).
