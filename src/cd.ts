import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  Container,
  decodeKittyPrintable,
  fuzzyFilter,
  getKeybindings,
  Spacer,
  Text,
  type AutocompleteItem,
} from "@earendil-works/pi-tui";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

const MAX_SUGGESTIONS = 50;
const MAX_RECENTS = 12;
const MAX_PICKER_DIRS = 30;

const STATE_FILE = join(homedir(), ".pi", "agent", "pi-cd-state.json");
const ROOT_MARKERS = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"];

type State = {
  recents: string[];
  bookmarks: Record<string, string>;
  previous?: string;
};

function readState(): State {
  const empty: State = { recents: [], bookmarks: {} };
  try {
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as Partial<State>;
    const recents = Array.isArray(raw.recents)
      ? raw.recents.filter((item): item is string => typeof item === "string").slice(0, MAX_RECENTS)
      : [];
    const bookmarks: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.bookmarks ?? {})) {
      if (typeof value === "string") bookmarks[key] = value;
    }
    const previous = typeof raw.previous === "string" ? raw.previous : undefined;
    return { recents, bookmarks, previous };
  } catch {
    return empty;
  }
}

function writeState(state: State): void {
  try {
    mkdirSync(dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    return;
  }
}

function toAbsolute(input: string, base: string): string {
  const expanded = input.replace(/^~(?=$|[\\/])/, homedir());
  return isAbsolute(expanded) ? resolve(expanded) : resolve(base, expanded);
}

function realPath(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return input;
  }
}

function walkUp(start: string, matches: (dir: string) => boolean): string | null {
  let dir = start;
  for (;;) {
    if (matches(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function findProjectRoot(start: string): { path: string; marker: string } | null {
  const git = walkUp(start, (dir) => existsSync(join(dir, ".git")));
  if (git) return { path: git, marker: ".git" };

  for (const marker of ROOT_MARKERS) {
    const hit = walkUp(start, (dir) => existsSync(join(dir, marker)));
    if (hit) return { path: hit, marker };
  }

  return null;
}

function listDirectories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function remember(state: State, path: string): void {
  const canonical = realPath(path);
  state.recents = [path, ...state.recents.filter((item) => realPath(item) !== canonical)].slice(0, MAX_RECENTS);
}

function paint(label: string, dir: string): AutocompleteItem {
  return { value: label, label, description: dir };
}

function suggestDirectories(prefix: string, base: string): AutocompleteItem[] {
  const arg = prefix === "~" ? `~${sep}` : prefix;
  const endsWithSlash = arg.endsWith("/") || arg.endsWith(sep);
  const namePart = endsWithSlash ? "" : basename(arg);
  const rawPrefix = endsWithSlash ? arg : arg.slice(0, arg.length - namePart.length);
  const dirPart = endsWithSlash ? arg : dirname(arg);
  const searchDir = dirPart ? toAbsolute(dirPart, base) : base;
  const showHidden = namePart.startsWith(".");
  const needle = namePart.toLowerCase();

  let entries;
  try {
    entries = readdirSync(searchDir, { withFileTypes: true });
  } catch {
    return [];
  }

  return entries
    .filter((entry) => entry.isDirectory())
    .filter((entry) => entry.name.toLowerCase().startsWith(needle))
    .filter((entry) => showHidden || !entry.name.startsWith("."))
    .sort((a, b) => {
      const exact = Number(!a.name.startsWith(namePart)) - Number(!b.name.startsWith(namePart));
      return exact !== 0 ? exact : a.name.localeCompare(b.name);
    })
    .slice(0, MAX_SUGGESTIONS)
    .map((entry) => ({
      value: `${rawPrefix}${entry.name}${sep}`,
      label: `${entry.name}${sep}`,
      description: searchDir,
    }));
}

function suggestFlags(prefix: string): AutocompleteItem[] {
  const flags: AutocompleteItem[] = [
    paint("--root", "jump to the nearest project root"),
    paint("-r", "alias for --root"),
    paint("--home", "jump to your home directory"),
    paint("--new", "switch without carrying this conversation"),
    paint("-n", "alias for --new"),
    paint("--save", "bookmark the current directory"),
    paint("--remove", "delete a bookmark"),
    paint("--recents", "pick from recently visited directories"),
    paint("--clear-recents", "forget the recent list"),
    paint("-", "go back to the previous directory"),
  ];
  const needle = prefix.toLowerCase();
  return flags.filter((flag) => flag.value.startsWith(needle));
}

type PickerEntry = { label: string; path: string; kind: "commit" | "enter" };

type PickerTheme = {
  fg(color: "accent" | "text" | "muted" | "warning", text: string): string;
  bold(text: string): string;
};

const MAX_VISIBLE = 10;

class DirectoryPicker extends Container {
  private query = "";
  private index = 0;
  private pinned: PickerEntry;
  private rest: PickerEntry[] = [];
  private visible: PickerEntry[] = [];
  private title = new Text("", 1, 0);
  private hint = new Text("", 1, 0);
  private list = new Container();
  private current: string;
  private state: State;
  private theme: PickerTheme;
  private finish: (path: string | null) => void;

  constructor(current: string, state: State, theme: PickerTheme, finish: (path: string | null) => void) {
    super();
    this.current = current;
    this.state = state;
    this.theme = theme;
    this.finish = finish;
    this.pinned = { label: "", path: this.current, kind: "commit" };
    this.addChild(new Spacer(1));
    this.addChild(this.title);
    this.addChild(this.list);
    this.addChild(new Spacer(1));
    this.addChild(this.hint);
    this.addChild(new Spacer(1));
    this.build();
  }

  private build(): void {
    const entries: PickerEntry[] = [];
    const seen = new Set<string>([realPath(this.current)]);

    const add = (label: string, path: string, kind: "commit" | "enter") => {
      const key = realPath(path);
      if (seen.has(key) || !existsSync(path)) return;
      seen.add(key);
      entries.push({ label: `${label}  ${path}`, path, kind });
    };

    const parent = dirname(this.current);
    if (parent !== this.current) add("parent", parent, "enter");

    const previous = this.state.previous;
    if (previous && previous !== this.current) add("previous", previous, "commit");

    for (const [name, path] of Object.entries(this.state.bookmarks)) {
      add(`bookmark ${name}`, path, "commit");
    }

    for (const name of listDirectories(this.current).slice(0, MAX_PICKER_DIRS)) {
      add(`enter ${name}${sep}`, join(this.current, name), "enter");
    }

    this.pinned = { label: `use this folder  ${this.current}`, path: this.current, kind: "commit" };
    this.rest = entries;
    this.refresh();
  }

  private descend(path: string): void {
    this.current = path;
    this.query = "";
    this.build();
  }

  private refresh(): void {
    this.index = 0;
    this.visible = this.query ? fuzzyFilter(this.rest, this.query, (entry) => entry.label) : [this.pinned, ...this.rest];
    this.paint();
  }

  private paint(): void {
    this.title.setText(this.theme.fg("accent", this.theme.bold(`cd — ${this.current}`)));
    this.hint.setText(
      this.query
        ? `filter: ${this.query}`
        : this.theme.fg("muted", "type to filter · ↑↓ move · enter select · esc cancel"),
    );

    this.list.clear();
    const total = this.visible.length;
    if (total === 0) {
      this.list.addChild(new Text(this.theme.fg("muted", "  no matches"), 1, 0));
      return;
    }

    const start = Math.max(0, Math.min(this.index - Math.floor(MAX_VISIBLE / 2), total - MAX_VISIBLE));
    const end = Math.min(start + MAX_VISIBLE, total);

    for (let i = start; i < end; i += 1) {
      const entry = this.visible[i];
      const line = i === this.index ? this.theme.fg("accent", `→ ${entry.label}`) : `  ${entry.label}`;
      this.list.addChild(new Text(line, 1, 0));
    }

    if (start > 0 || end < total) {
      this.list.addChild(new Text(this.theme.fg("muted", `  (${this.index + 1}/${total})`), 1, 0));
    }
  }

  handleInput(data: string): void {
    const kb = getKeybindings();

    if (kb.matches(data, "tui.select.up")) {
      this.index = this.index === 0 ? this.visible.length - 1 : this.index - 1;
      this.paint();
      return;
    }

    if (kb.matches(data, "tui.select.down")) {
      this.index = this.index === this.visible.length - 1 ? 0 : this.index + 1;
      this.paint();
      return;
    }

    if (kb.matches(data, "tui.select.confirm")) {
      const entry = this.visible[this.index];
      if (!entry) return;
      if (entry.kind === "enter" && !this.query) {
        this.descend(entry.path);
        return;
      }
      this.finish(entry.path);
      return;
    }

    if (kb.matches(data, "tui.select.cancel")) {
      this.finish(null);
      return;
    }

    if (data === "\x7f" || data === "\b") {
      if (this.query) {
        this.query = this.query.slice(0, -1);
        this.refresh();
      }
      return;
    }

    const plainBurst = data.length > 0 && data >= " " && !data.includes("\x1b") ? data : undefined;
    const printable = decodeKittyPrintable(data) ?? plainBurst;
    if (printable) {
      this.query += printable;
      this.refresh();
    }
  }
}

async function pickDirectory(ctx: ExtensionCommandContext): Promise<string | null> {
  return await ctx.ui.custom<string | null>((_tui, theme, _keybindings, done) => {
    return new DirectoryPicker(ctx.cwd, readState(), theme, done);
  });
}

async function switchTo(
  ctx: ExtensionCommandContext,
  rawTarget: string,
  options: { fresh?: boolean; note?: string } = {},
): Promise<boolean> {
  const shown = toAbsolute(rawTarget, ctx.cwd);
  if (!existsSync(shown) || !statSync(shown).isDirectory()) {
    ctx.ui.notify(`Not a directory: ${shown}`, "error");
    return false;
  }

  const target = realPath(shown);
  const here = realPath(ctx.cwd);

  if (target === here) {
    ctx.ui.notify(`${options.note ?? ""}Already in ${shown}`.trim(), "info");
    return false;
  }

  const currentFile = ctx.sessionManager.getSessionFile();
  if (!currentFile) {
    ctx.ui.notify("Session is not saved (--no-session). Start pi inside that directory instead.", "error");
    return false;
  }

  if (!ctx.isIdle()) {
    if (ctx.hasUI) {
      const proceed = await ctx.ui.confirm(
        "Agent is busy",
        `Switching to ${shown} aborts the current turn. Continue?`,
      );
      if (!proceed) {
        ctx.ui.notify("Directory change cancelled.", "warning");
        return false;
      }
    }
    ctx.abort();
    await ctx.waitForIdle();
  }

  const fromId = ctx.sessionManager.getSessionId();
  const hasHistory = !options.fresh && existsSync(currentFile) && statSync(currentFile).size > 0;

  let moved;
  try {
    moved = hasHistory
      ? SessionManager.forkFrom(currentFile, target)
      : SessionManager.create(target, undefined, { parentSession: currentFile });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Could not prepare a session in ${target}: ${reason}`, "error");
    return false;
  }

  const movedFile = moved.getSessionFile();
  const movedHeader = moved.getHeader();
  if (!movedFile || !movedHeader) {
    ctx.ui.notify("Could not create a session in that directory.", "error");
    return false;
  }

  if (!hasHistory) {
    try {
      writeFileSync(movedFile, `${JSON.stringify(movedHeader)}\n`, { flag: "wx" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      ctx.ui.notify(`Could not write the new session file: ${reason}`, "error");
      return false;
    }
  }
  const state = readState();
  state.previous = ctx.cwd;
  remember(state, shown);

  const result = await ctx.switchSession(movedFile, {
    withSession: async (fresh) => {
      const toId = fresh.sessionManager.getSessionId();
      const kind = hasHistory ? "session forked" : "new session";
      const tag = options.note ? `${options.note.trim()}, ` : "";
      fresh.ui.notify(`cwd -> ${shown}  (${tag}${kind} ${fromId.slice(0, 8)} -> ${toId.slice(0, 8)})`, "info");
    },
  });

  if (result.cancelled) {
    ctx.ui.notify("Directory change cancelled.", "warning");
    return false;
  }

  writeState(state);

  return true;
}

export default function (pi: ExtensionAPI) {
  let sessionCwd = process.cwd();

  pi.on("session_start", async (_event, ctx) => {
    sessionCwd = ctx.cwd;
  });

  pi.registerCommand("cd", {
    description: "Change the session working directory without leaving pi",
    getArgumentCompletions: (prefix) => {
      if (prefix.startsWith("-")) {
        const flags = suggestFlags(prefix);
        return flags.length > 0 ? flags : null;
      }
      const items = suggestDirectories(prefix, sessionCwd);
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const input = args.trim();
      const state = readState();
      const [head, ...rest] = input.split(/\s+/).filter(Boolean);

      if (!head) {
        if (!ctx.hasUI) {
          ctx.ui.notify(`cwd: ${ctx.cwd}`, "info");
          return;
        }
        const picked = await pickDirectory(ctx);
        if (!picked) return;
        await switchTo(ctx, picked);
        return;
      }

      if (head === "--help" || head === "-h") {
        ctx.ui.notify("usage: /cd [path | - | @bookmark | --root | --home | --new | --save <name> | --remove <name> | --recents | --clear-recents]", "info");
        return;
      }

      if (head === "--clear-recents") {
        state.recents = [];
        writeState(state);
        ctx.ui.notify("Recent directories cleared.", "info");
        return;
      }

      if (head === "--save") {
        const name = rest[0];
        if (!name) {
          ctx.ui.notify("usage: /cd --save <name> [path]", "warning");
          return;
        }
        const target = rest[1] ? toAbsolute(rest[1], ctx.cwd) : ctx.cwd;
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          ctx.ui.notify(`Not a directory: ${target}`, "error");
          return;
        }
        state.bookmarks[name] = target;
        writeState(state);
        ctx.ui.notify(`Bookmarked ${name} -> ${state.bookmarks[name]}`, "info");
        return;
      }

      if (head === "--remove") {
        const name = rest[0];
        if (!name) {
          ctx.ui.notify("usage: /cd --remove <name>", "warning");
          return;
        }
        if (!(name in state.bookmarks)) {
          ctx.ui.notify(`No bookmark named ${name}`, "warning");
          return;
        }
        delete state.bookmarks[name];
        writeState(state);
        ctx.ui.notify(`Removed bookmark ${name}`, "info");
        return;
      }

      if (head === "--home") {
        await switchTo(ctx, homedir());
        return;
      }

      if (head === "--root" || head === "-r") {
        const found = findProjectRoot(ctx.cwd);
        if (!found) {
          ctx.ui.notify(`No project root found above ${ctx.cwd}. Try /cd ~ or /cd --home.`, "warning");
          return;
        }
        await switchTo(ctx, found.path, { note: `(${found.marker}) ` });
        return;
      }
      if (head === "--new" || head === "-n") {
        const path = rest[0];
        if (!path) {
          ctx.ui.notify("usage: /cd --new <path>", "warning");
          return;
        }
        await switchTo(ctx, toAbsolute(path, ctx.cwd), { fresh: true });
        return;
      }
      if (head === "--recents") {
        if (state.recents.length === 0) {
          ctx.ui.notify("No recent directories yet.", "warning");
          return;
        }
        if (!ctx.hasUI) {
          ctx.ui.notify(state.recents.join("\n"), "info");
          return;
        }
        const choice = await ctx.ui.select("recent directories", state.recents);
        if (!choice) return;
        await switchTo(ctx, choice);
        return;
      }

      if (head === "-") {
        if (!state.previous) {
          ctx.ui.notify("No previous directory yet.", "warning");
          return;
        }
        await switchTo(ctx, state.previous);
        return;
      }

      if (head.startsWith("-") && head !== "-") {
        ctx.ui.notify(`Unknown option: ${head}. Try /cd --help`, "warning");
        return;
      }

      if (head.startsWith("@")) {
        const name = head.slice(1);
        const path = state.bookmarks[name];
        if (!path) {
          ctx.ui.notify(`No bookmark named ${name}`, "warning");
          return;
        }
        await switchTo(ctx, path);
        return;
      }

      const typed = toAbsolute(head, ctx.cwd);
      if (!existsSync(typed) && state.bookmarks[head]) {
        await switchTo(ctx, state.bookmarks[head]);
        return;
      }

      await switchTo(ctx, typed, { fresh: rest.includes("--new") || rest.includes("-n") || head === "--new" || head === "-n" });
    },
  });
}
