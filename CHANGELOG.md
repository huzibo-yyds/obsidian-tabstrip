# Changelog

## 0.2.0 (2026-11-17)

First public release.

### New: vertical tab strip (experimental)

- The command "Toggle vertical tabs (experimental)" switches the main window between Obsidian's horizontal tab bar and a vertical list of tabs at the far left. No default hotkey; the choice is stored per device and the default stays horizontal.
- The list shows pinned tabs first, then one section per pane, with a row per group (name, colour, number of tabs) before its tabs, coloured bars on group members, greyed tabs that are not loaded yet, and a "New tab" row. Collapsed groups hide their tabs, as on the horizontal tab bar.
- Mouse: click shows a tab, middle-click or × closes it, right-click opens Obsidian's tab menu with the group items or the group menu, and clicking a group row collapses or expands it.
- Icon bar: the header button or the command "Collapse/expand vertical tab strip" shrinks the strip to a 48 px bar of icons and group markers; hovering it opens it over the workspace without moving anything. Drag the strip's edge to set its width (180 to 480 px). Width and icon bar are stored per device.
- Keyboard: the list is a tree with one tab stop (arrow keys, Home, End, Enter, Space, Delete, F2, Shift+F10 or the context-menu key; Alt+Arrow Up / Down moves a tab). Screen readers get levels, positions and states in English and Chinese.
- Drag and drop: drag rows to reorder tabs and move them into or out of groups, with the same rules as on the horizontal tab bar, also across panes. Outside the strip the drag is Obsidian's own tab drag (split, other panes, sidebars, pop-out windows, a new window). Stacked panes keep all their drop zones.
- Switching orientation keeps groups, pinned tabs, collapsed groups, the tab order, the active tab and the cursor; the layout does not change and no frame shows both tab bars or neither. A switch asked for during a drag waits for the drag to end.
- Pop-out windows keep the horizontal tab bar. If the Vertical Tabs plugin seems to be enabled, a notice (once per session, in either orientation) says that the two overlap; Tabstrip does not disable it.

### Other changes

- New commands "Move current tab up (left) one place" and "Move current tab down (right) one place" (no default hotkeys), in both orientations.
- "Restore native tab bar" and disabling the plugin remove the vertical strip too; "Show tab groups again" and enabling the plugin bring back the same orientation.
- The command to clear the stored data is now called "Clear data on this device"; it also clears the stored orientation, width and icon bar state.
- Better high-contrast (forced colours) support in the vertical strip, and visible separators in themes with a transparent divider (such as Atom).

### Known limitations

- In vertical mode a normal pane cannot be split to the top by dragging, and a drop in the centre of a pane puts the tab at its end without a position marker.
- Tested on macOS only (Obsidian 1.13.4, 1.14.4 and 1.15.0); not yet on Windows or Linux.

## 0.1.0 (2026-11-11)

First version, for personal use (not published). Desktop only, horizontal tab bar only.

- Tab groups on Obsidian's own tab bar: name, nine colours, chip and underline like Chrome.
- Group menus and commands (no default hotkeys): new group, add to group, remove from group, rename, recolour, ungroup, close group, new tab in group.
- Collapse and expand groups; the shown tab is never hidden; "Collapse other groups"; skip-collapsed tab switching.
- Groups survive a restart (per device); "Undo close tab" puts a tab back into its group; unmatched groups can be restored later; a command to clear the stored data on this device.
- Drag tabs into and out of groups with Obsidian's own tab drag, with a highlight of the group the tab would join.
- Chrome-like colours derived from Obsidian's colour variables; high-contrast (forced colours) support.
- Tested on Obsidian 1.13.4, 1.14.4 and 1.15.0 (macOS sandbox); not yet tested on Windows.
