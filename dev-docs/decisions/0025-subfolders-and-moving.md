# 25. Subfolders and moving: nesting is display, paths stay flat

- **Status:** accepted (2026-09-16)
- **Date:** 2026-09-16
- **Supersedes:** — (extends ADR 0017 on folders; answers two questions the visitor-access map
  left in fog)

## Context

The console's estate is a tree (ADR 0024), and a tree that cannot nest or reorganize is a list.
The owner asked for both: folders inside folders, and drag-and-drop moves. Two fears sat in the
way: the map had left "may an artefact move between folders" open, and every nesting scheme that
touches paths risks breaking a handed-out link — the one failure this platform exists to prevent.

## Decision

1. **A folder may have a parent** (`folders.parent_id`, migration 0005). Nesting is a *display
   hierarchy* — it organizes the owner's console tree and nothing else.
2. **Every public path stays flat.** A subfolder's index is still `/<slug>/`, an artefact is still
   `/<slug>/` or a preserved two-segment legacy link. Nesting changes no URL, so reorganizing the
   tree can never break a link that was handed out — the answer to the fog question is therefore
   yes, moves are allowed, because they are free of the only cost that mattered.
3. **Moves are same-owner only.** An artefact moves between the owner's own folders
   (`artifacts.moveTo`); a folder moves under another of the owner's folders or back to the root
   (`folders.setParent`). A folder can never be moved into itself or its own descendant (the model
   walks the ancestor chain and refuses with `folder-cycle`).
4. **The console exposes moves twice:** drag-and-drop in the tree (the fast path, JSON POST) and a
   "Move" form on the artefact and folder panes (the no-JS path). Same endpoints, same audit rows
   (`artifact.move`, `folder.move`).
5. **Subfolder creation** lives in the tree's `+` menu (inline, name only — the path is the id
   until the folder is named, per ADR 0017) and as a form on the folder pane.
6. **The folder index (public) is unchanged**: it lists the folder's own artefacts. A subfolder is
   reached by its own link. Whether a folder's share someday includes its subfolders is the share
   phase's call (the map already leans yes); this ADR deliberately does not decide it.

## Alternatives considered

- **Hierarchical paths** (`/<folder>/<sub>/<artefact>/`). Rejected: any rename or move would retire
  a path, and the alias machinery would end up carrying the owner's reorganizations — exactly the
  churn flat paths were chosen to avoid (ADR 0016).
- **Groups instead of subfolders** (the map's *group*: a personal view that is never shared).
  Rejected as a substitute: groups answer "my own arrangement of other people's folders", a
  different need. Subfolders are real containment. Groups remain possible later, on top.
- **Move by API only.** Rejected: the owner asked for tree drag-and-drop, and the form fallback
  keeps the console usable with scripts off.

## Consequences

- **Good:** the estate tree behaves like a file tree — nest, collapse, move — with zero link risk.
- **Good:** the move endpoints (`POST /app/a/<ref>/move`, `POST /app/f/<ref>/move`,
  `POST /app/f/<ref>/subfolder`) are the contract; the tree's JavaScript is replaceable chrome.
- **Accepted cost:** the console now ships one small inline script (collapse state, popovers,
  drag-and-drop, the sidebar size switch). It is dependency-free and fails soft: with scripts off,
  the tree still navigates and every action still has a form.
- **Open:** folder shares over subtrees, and groups, stay in the visitor-access map.
