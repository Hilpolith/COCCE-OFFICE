// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/officeWorkbench.css', 'utf8');
const sheet = new CSSStyleSheet();
sheet.replaceSync(source);

describe('Office workbench style boundaries', () => {
  it('keeps visual appearance screen-only and excludes the new rail/navigation from print', () => {
    expect(sheet.cssRules.length).toBe(2);
    const screen = sheet.cssRules[0] as CSSMediaRule;
    const print = sheet.cssRules[1] as CSSMediaRule;
    expect(screen.conditionText).toBe('screen');
    expect(print.conditionText).toBe('print');
    const hidden = print.cssRules[0] as CSSStyleRule;
    const layout = print.cssRules[1] as CSSStyleRule;
    expect(hidden.selectorText.split(',').map((value) => value.trim())).toEqual(['.office-editor-chrome', '.office-workbench-rail']);
    expect(hidden.style.getPropertyValue('display')).toBe('none');
    expect(hidden.style.getPropertyPriority('display')).toBe('important');
    expect(layout.selectorText.split(',').map((value) => value.trim())).toEqual(['.office-workbench-layout', '.office-workbench-editor']);
    expect(layout.style.getPropertyValue('display')).toBe('block');
    expect(layout.style.getPropertyPriority('display')).toBe('important');
  });

  it('scopes toolbar refinements to the named editor-page class and uses accessibility-controlled blur tokens', () => {
    expect(source).toContain('.office-editor-page .editor-toolbar,.office-editor-page .sheet-editor-topline,.office-editor-page .slides-editor-toolbar');
    expect(source).not.toContain('.editor-toolbar,.sheet-editor-topline,.slides-editor-toolbar');
    expect(source).not.toMatch(/backdrop-filter:blur\(/);
    expect(source).toContain('backdrop-filter:var(--glass-filter)');
    expect(source).toContain('backdrop-filter:var(--glass-mini-filter)');
  });
});
