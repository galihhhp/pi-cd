# pi-cd

Changing directory mid-conversation is the one thing a terminal agent cannot do for you. Pi binds its working directory to the session, so `cd` inside a bash tool call moves that shell and nothing else: the file tools, the project instructions, the session storage and the footer all stay where you started. The usual workaround is to quit pi, walk to the folder, and start over — which throws away the conversation you were in the middle of.

`pi-cd` closes that gap. `/cd <path>` moves the whole session: tools, context files, session storage and footer follow you, and the conversation comes along. Navigating a repo, hopping from a library into its consumer, or leaving a scratch directory for a real project no longer costs you your context.

## Install

```bash
pi install npm:@galpangestu/pi-cd
```

Or from a checkout:

```bash
pi install ./pi-cd
```

Or try it once without installing:

```bash
pi -e ./pi-cd/src/cd.ts
```

Then `/reload` in an open session.

## Usage

```
/cd                      interactive folder picker
/cd ../other-repo        relative path
/cd ~/Documents          tilde works
/cd --root               jump to the nearest project root
/cd --home               jump to your home directory
/cd -                    back to the previous directory
/cd --recents            pick from recently visited directories
/cd --new <path>         switch with a fresh conversation
/cd --save work          bookmark the current directory as "work"
/cd work                 jump to a bookmark by name
/cd @work                same, explicit bookmark lookup
/cd --remove work        delete a bookmark
/cd --clear-recents      forget the recent list
/cd --help               remind yourself of the above
```

Tab completion works on paths, and it offers flags once you type `-`. Matching is case-insensitive, so `/cd doc` finds `Documents/`, and exact-case matches sort first.

## The picker

With no arguments, `/cd` opens a live search browser instead of demanding a path you half-remember. Start typing and the list filters on every keystroke. Matching is fuzzy, so `doc` narrows to `Documents/` and `deploy-docs/`, and a bookmark named `work` is found by typing its name even though the folder is called something else.

The first line is always "use this folder", so Enter without typing keeps you where you are. Below it: the parent directory, your previous directory, your bookmarks, then the subdirectories of where you stand. Arrows walk a tree without retyping paths — Enter on a subdirectory descends and the list rebuilds for the new directory. Once a filter is active, Enter commits the matched directory instead, because typing is a decision and arrows are exploration. Escape cancels without moving anything.

## Roots

`--root` (or `-r`) is the project root: it walks upward looking for `.git` first, then `package.json`, `pyproject.toml`, `go.mod` or `Cargo.toml`. Git wins deliberately: in a monorepo, the place you want a session rooted is the repository, not the innermost package manifest. When nothing above qualifies it says so rather than guessing.

Home has two names and neither is a flag you have to remember: `/cd ~` for typing, `/cd --home` if you prefer words. There is no `--root`-means-home overload, because every other command-line tool treats "root" as the top of something, not as your user directory.

## What actually happens when you switch

Pi cannot rename a directory underneath a live runtime, so `/cd` creates a session file whose header records the destination and switches to it. With history, the current session is forked: entries are copied, the new file names the old one as its parent, and `/resume` shows the chain. The notification states which session id you came from and which you landed in, so a changed id is never a surprise.

Files land in the destination directory's own session folder, which is what makes `/resume` from that directory later find the conversation.

Two edge cases are handled rather than hidden. A session with no messages yet has no file to fork, so a header-only file is written for the destination. Symlinked paths are resolved before comparison, so `/tmp/x` and `/private/tmp/x` are recognised as the same place instead of forking a duplicate session for a directory you are already standing in.

## Paths: what you typed versus what pi stores

Display and storage disagree on purpose. The path you type is what you see back — in the confirmation, in recents, in bookmarks — so `/tmp/it2/sub` stays `/tmp/it2/sub` and is not rewritten into the resolved path behind your back.

The session itself is created against the resolved path, because a session file lives in a directory named after its working directory. Storing the unresolved form there would file the session somewhere pi does not look when you later resume from that same directory. So the header records `/private/tmp/it2/sub` while the notification and the recent list say `/tmp/it2/sub`.

One consequence worth stating: paths handed to you by pi, such as the current directory it reports at startup, are already resolved, so those appear in resolved form. Only paths you type keep their original spelling.

## State

Recents, bookmarks and the previous directory live in `~/.pi/agent/pi-cd-state.json`. Delete the file to reset; nothing else depends on it. It holds plain paths, never file contents.

## Limits

- Requires a persisted session. With `--no-session` there is no conversation to move, and the command says so instead of pretending.
- Switching aborts a streaming turn. When the agent is working you are asked to confirm first; in headless modes it aborts without asking, because there is nobody to ask.
- Each switch costs one session file. Fifty moves means fifty files in the resume chain. That is the price of changing an immutable binding; bookmarks and `-` are how you avoid paying it repeatedly.
- Directory deletion underneath a session is still a problem this does not solve. If the current directory vanishes, resume behaves the way pi normally does.

## License

MIT.
