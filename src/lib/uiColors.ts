// Turns a VS Code theme's `colors` into CSS variables for the whole workbench,
// so the sidebar, tabs, panels and terminal follow the theme too.
import type { ITheme } from "@xterm/xterm";
import type { ActiveTheme } from "./highlighting";

const fallback = {
  dark: {
    "editor.background": "#1e1e1e", "editor.foreground": "#d4d4d4", "foreground": "#cccccc",
    "sideBar.background": "#252526", "activityBar.background": "#333333", "activityBar.foreground": "#ffffff",
    "statusBar.background": "#007acc", "statusBar.foreground": "#ffffff", "focusBorder": "#007fd4",
    "list.hoverBackground": "#2a2d2e", "list.activeSelectionBackground": "#04395e",
    "input.background": "#3c3c3c", "button.background": "#0e639c", "button.foreground": "#ffffff",
    "panel.border": "#80808059", "widget.shadow": "#0000005c", "descriptionForeground": "#ccccccb3",
  },
  light: {
    "editor.background": "#ffffff", "editor.foreground": "#000000", "foreground": "#616161",
    "sideBar.background": "#f3f3f3", "activityBar.background": "#2c2c2c", "activityBar.foreground": "#ffffff",
    "statusBar.background": "#007acc", "statusBar.foreground": "#ffffff", "focusBorder": "#0090f1",
    "list.hoverBackground": "#e8e8e8", "list.activeSelectionBackground": "#0060c0",
    "input.background": "#ffffff", "button.background": "#007acc", "button.foreground": "#ffffff",
    "panel.border": "#80808059", "widget.shadow": "#00000029", "descriptionForeground": "#717171",
  },
};

export function themeToCssVars(theme: ActiveTheme): Record<string, string> {
  const c = theme.colors;
  const f = fallback[theme.type];
  const get = (...keys: string[]) => {
    for (const k of keys) if (c[k]) return c[k];
    for (const k of keys) if ((f as Record<string, string>)[k]) return (f as Record<string, string>)[k];
    return "";
  };
  const editorBg = get("editor.background");
  const fg = get("foreground", "editor.foreground");
  return {
    "--editor-bg": editorBg,
    "--editor-fg": get("editor.foreground"),
    "--fg": fg,
    "--fg-muted": get("descriptionForeground"),
    "--title-bg": get("titleBar.activeBackground", "sideBar.background"),
    "--title-fg": get("titleBar.activeForeground", "foreground"),
    "--activity-bg": get("activityBar.background"),
    "--activity-fg": get("activityBar.foreground"),
    "--activity-inactive-fg": get("activityBar.inactiveForeground", "descriptionForeground"),
    "--activity-active-border": get("activityBar.activeBorder", "focusBorder"),
    "--sidebar-bg": get("sideBar.background"),
    "--sidebar-fg": get("sideBar.foreground", "foreground"),
    "--sidebar-title-fg": get("sideBarTitle.foreground", "sideBar.foreground", "foreground"),
    "--section-header-bg": get("sideBarSectionHeader.background", "sideBar.background"),
    "--tabs-bg": get("editorGroupHeader.tabsBackground", "sideBar.background"),
    "--tab-active-bg": get("tab.activeBackground", "editor.background"),
    "--tab-active-fg": get("tab.activeForeground", "foreground"),
    "--tab-inactive-bg": get("tab.inactiveBackground", "editorGroupHeader.tabsBackground", "sideBar.background"),
    "--tab-inactive-fg": get("tab.inactiveForeground", "descriptionForeground"),
    "--tab-border": get("tab.border", "editorGroup.border", "panel.border"),
    "--tab-active-border": get("tab.activeBorderTop", "tab.activeBorder", "focusBorder"),
    "--panel-bg": get("panel.background", "editor.background"),
    "--panel-border": get("panel.border", "editorGroup.border"),
    "--status-bg": get("statusBar.background"),
    "--status-fg": get("statusBar.foreground"),
    "--status-noroot-bg": get("statusBar.noFolderBackground", "statusBar.background"),
    "--list-hover": get("list.hoverBackground"),
    "--list-active": get("list.activeSelectionBackground"),
    "--list-active-fg": get("list.activeSelectionForeground", "foreground"),
    "--list-inactive": get("list.inactiveSelectionBackground", "list.hoverBackground"),
    "--list-highlight": get("list.highlightForeground", "focusBorder"),
    "--input-bg": get("input.background"),
    "--input-fg": get("input.foreground", "foreground"),
    "--input-border": get("input.border", "panel.border"),
    "--focus": get("focusBorder"),
    "--button-bg": get("button.background"),
    "--button-fg": get("button.foreground"),
    "--widget-bg": get("quickInput.background", "editorWidget.background", "sideBar.background"),
    "--widget-border": get("editorWidget.border", "widget.border", "panel.border"),
    "--shadow": get("widget.shadow"),
    "--border": get("contrastBorder", "panel.border"),
    "--scrollbar": get("scrollbarSlider.background", "panel.border"),
    "--modified": get("editorGutter.modifiedBackground", "gitDecoration.modifiedResourceForeground", "focusBorder"),
    "--error": get("errorForeground", "editorError.foreground") || "#f48771",
  };
}

export function themeToXterm(theme: ActiveTheme): ITheme {
  const c = theme.colors;
  const t = (k: string) => c[`terminal.${k}`];
  return {
    background: c["terminal.background"] ?? c["panel.background"] ?? c["editor.background"],
    foreground: t("foreground") ?? c["editor.foreground"],
    cursor: c["terminalCursor.foreground"] ?? c["editorCursor.foreground"],
    selectionBackground: c["terminal.selectionBackground"] ?? c["editor.selectionBackground"],
    black: t("ansiBlack"), red: t("ansiRed"), green: t("ansiGreen"), yellow: t("ansiYellow"),
    blue: t("ansiBlue"), magenta: t("ansiMagenta"), cyan: t("ansiCyan"), white: t("ansiWhite"),
    brightBlack: t("ansiBrightBlack"), brightRed: t("ansiBrightRed"), brightGreen: t("ansiBrightGreen"),
    brightYellow: t("ansiBrightYellow"), brightBlue: t("ansiBrightBlue"), brightMagenta: t("ansiBrightMagenta"),
    brightCyan: t("ansiBrightCyan"), brightWhite: t("ansiBrightWhite"),
  };
}
