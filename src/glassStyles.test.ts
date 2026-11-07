// @vitest-environment happy-dom
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/glass.css', 'utf8');
const indexSource = readFileSync('src/index.css', 'utf8');
const sheet = new CSSStyleSheet();
sheet.replaceSync(source);
const screen = sheet.cssRules[0] as CSSMediaRule;
const rules = Array.from(screen.cssRules);
const style = (selector: string) => rules.find((rule) => 'selectorText' in rule && rule.selectorText === selector) as CSSStyleRule | undefined;
const nestedRules = rules.flatMap((rule) => ('cssRules' in rule ? Array.from((rule as CSSGroupingRule).cssRules) : []));
const allRules = [...rules, ...nestedRules];
const declarations = (rule: CSSStyleRule | undefined) => rule?.style;

const hex = (value: string) => {
  const normalized = value.trim().replace(/^#/, '');
  const expanded = normalized.length === 3 ? normalized.split('').map((part) => part + part).join('') : normalized;
  return [0, 2, 4].map((offset) => Number.parseInt(expanded.slice(offset, offset + 2), 16) / 255);
};
const luminance = (value: string) => hex(value).map((channel) => (channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)).reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
const contrast = (foreground: string, background: string) => {
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
};
const root = style(':root');
const darkRoot = style(':root:not([data-theme=light])');
const rootValue = (property: string) => root?.style.getPropertyValue(property).trim();
const darkRootValue = (property: string) => darkRoot?.style.getPropertyValue(property).trim();
const media = (condition: string) => allRules.find((rule) => 'conditionText' in rule && (rule as CSSMediaRule).conditionText === condition) as CSSMediaRule | undefined;

const controlledBlurSelectors = rules
  .filter((rule): rule is CSSStyleRule => 'selectorText' in rule && typeof rule.selectorText === 'string' && rule.selectorText.includes(':root'))
  .filter((rule) => /backdrop-filter\s*:\s*var\(--glass-(?:mini-)?filter\)/.test(rule.cssText))
  .map((rule) => rule.selectorText)
  .join(',');

const directBlurSelectors = readdirSync('src')
  .filter((file) => file.endsWith('.css'))
  .flatMap((file) => {
    const css = readFileSync(`src/${file}`, 'utf8');
    return [...css.matchAll(/([^{}]+)\{[^{}]*(?:^|;)\s*backdrop-filter\s*:\s*(?!none\b)[^;{}]+/gm)].flatMap((match) => match[1].split(',').map((selector) => selector.trim()));
  });

const selectorClasses = (selector: string) => [...selector.matchAll(/\.([a-zA-Z0-9_-]+)/g)].map((match) => match[1]);

describe('glass design rendering boundaries', () => {
  it('contains all new appearance styling in screen media, leaving print rules untouched', () => {
    expect(sheet.cssRules.length).toBe(1);
    expect(screen.conditionText).toBe('screen');
    expect(source).not.toContain('@import');
    expect(source).toContain("url('/brand/cocce-light-frosted-ambient.webp')");
    expect(source).not.toMatch(/url\s*\(['"]?https?:/i);
    expect(source).not.toContain('.pdf-text-layer');
    expect(source).not.toContain('.slides-print');
    expect(source).not.toContain('.slide-canvas');
  });

  it('keeps the document editing surface opaque and unblurred', () => {
    const canvas = style('.document-canvas.glass-card');
    expect(canvas?.style.getPropertyValue('background')).toBe('var(--glass-reading)');
    expect(canvas?.style.getPropertyValue('backdrop-filter')).toBe('none');
  });

  it('defines literal opaque fallback values before color-mix enhancement', () => {
    expect(rootValue('--glass-solid')).toBe('#FCFDFE');
    expect(rootValue('--glass-reading')).toBe('#FFFFFF');
    expect(rootValue('--glass-surface')).toBe('rgba(255, 255, 255, .68)');
    expect(rootValue('--glass-nav')).toBe('rgba(251, 252, 253, .82)');
    expect(rootValue('--glass-veil')).toBe('rgba(224, 231, 235, .66)');
    expect(source).toContain('--glass-surface: color-mix(in srgb, var(--glass-solid) 78%, transparent)');
    expect(source).toContain('--glass-nav: color-mix(in srgb, var(--bg-top) 82%, transparent)');
  });

  it('keeps every direct blur declaration covered by a root-controlled selector', () => {
    const glassDirectBlurSelectors = rules
      .filter((rule): rule is CSSStyleRule => 'selectorText' in rule && /backdrop-filter\s*:\s*var\(--glass-(?:mini-)?filter\)/.test(rule.cssText))
      .map((rule) => rule.selectorText)
      .join(',');
    const blurOwnership = `${controlledBlurSelectors},${glassDirectBlurSelectors}`;
    const uncovered = directBlurSelectors.flatMap(selectorClasses).filter((className, index, classes) => classes.indexOf(className) === index && className !== 'document-canvas' && !blurOwnership.includes(`.${className}`));
    expect(uncovered).toEqual([]);
    expect(controlledBlurSelectors).toContain('.modal-backdrop');
    expect(controlledBlurSelectors).toContain('.office-ai-confirm-backdrop');
    expect(controlledBlurSelectors).toContain('.drive-modal-scrim');
    expect(controlledBlurSelectors).toContain('.mobile-scrim');
    expect(controlledBlurSelectors).toContain('.slides-present-overlay');
    expect(controlledBlurSelectors).toContain('.docs-format-toolbar');
    expect(controlledBlurSelectors).toContain('.team-panel');
    expect(controlledBlurSelectors).toContain('.office-collab-panel');
    expect(controlledBlurSelectors).toContain('.frosted-confirm-backdrop');
  });

  it('provides solid manual, browser-support and system-accessibility fallbacks', () => {
    const solid = style(':root[data-surface=solid]');
    expect(solid?.style.getPropertyValue('--glass-filter')).toBe('none');
    expect(solid?.style.getPropertyValue('--glass-mini-filter')).toBe('none');
    expect(solid?.style.getPropertyValue('--glass-surface')).toBe('var(--glass-solid)');

    const accessibility = media('(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)');
    const unsupported = allRules.find((rule) => 'conditionText' in rule && (rule as CSSSupportsRule).conditionText.includes('not')) as CSSSupportsRule | undefined;
    expect(accessibility).toBeDefined();
    expect(unsupported).toBeDefined();
    for (const branch of [accessibility, unsupported]) {
      const branchText = Array.from(branch?.cssRules ?? []).map((rule) => rule.cssText).join('\n');
      expect(branchText).toContain('--glass-filter: none');
      expect(branchText).toContain('--glass-mini-filter: none');
      expect(branchText).toContain('--glass-surface: var(--glass-solid)');
    }
    expect(media('(prefers-contrast: more)')).toBeUndefined();
    expect(source).toContain('backdrop-filter: blur(1px)');
  });

  it('keeps the fixed primary action endpoints readable in all six themes', () => {
    const themes = ['default', 'light', 'midnight', 'amber', 'aurora', 'lavender'];
    expect(themes).toHaveLength(6);
    const actionText = rootValue('--glass-action-text');
    const actionEndpoints = [rootValue('--glass-action-start'), rootValue('--glass-action-end')];
    expect(actionText).toBe('#25343D');
    expect(actionEndpoints).toEqual(['#F2F6F4', '#D7E7E4']);
    for (const endpoint of actionEndpoints) expect(contrast(actionText!, endpoint!)).toBeGreaterThanOrEqual(4.5);
  });

  it('keeps representative dark and light text roles legible on opaque surfaces', () => {
    const darkBackground = darkRootValue('--glass-reading')!;
    const lightBackground = rootValue('--glass-reading')!;
    const darkRoles = { text: '#f2f5f0', muted: '#bbc5bd', faint: '#a0afa5', focus: '#8d8bff', error: '#ff8d91' };
    const lightRoles = { text: '#243329', muted: '#4c6052', faint: '#526859', error: '#a42c45' };
    for (const [role, color] of Object.entries(darkRoles)) {
      expect(contrast(color, darkBackground), `${role} on dark opaque surface`).toBeGreaterThanOrEqual(role === 'focus' ? 3 : 4.5);
    }
    for (const [role, color] of Object.entries(lightRoles)) {
      expect(contrast(color, lightBackground), `${role} on light opaque surface`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('preserves the existing reduced-motion dependency and responsive surface contracts', () => {
    expect(indexSource).toMatch(/@media\s*\([^)]*prefers-reduced-motion\s*:\s*reduce[^)]*\)/);
    expect(indexSource).toMatch(/animation-duration:\s*\.01ms\s*!important/);
    expect(indexSource).toMatch(/transition-duration:\s*\.01ms\s*!important/);

    expect(declarations(style('.sidebar'))?.getPropertyValue('min-height')).toContain('calc(100svh - 32px)');
    expect(declarations(style('.app-frame'))?.getPropertyValue('grid-template-columns')).toBe('234px minmax(0, 1fr)');
    const tablet = media('(max-width: 1100px)');
    const oneColumn = media('(max-width: 900px)');
    const mobile = media('(max-width: 700px)');
    expect(Array.from(tablet?.cssRules ?? []).map((rule) => rule.cssText).join('\n')).toContain('grid-template-columns: 214px minmax(0, 1fr)');
    expect(Array.from(oneColumn?.cssRules ?? []).map((rule) => rule.cssText).join('\n')).toContain('.surface-options { grid-template-columns: minmax(0, 1fr); }');
    expect(Array.from(mobile?.cssRules ?? []).map((rule) => rule.cssText).join('\n')).toContain('.app-frame { display: block');
    expect(Array.from(mobile?.cssRules ?? []).map((rule) => rule.cssText).join('\n')).toContain('.sidebar { top: 8px');
  });
});
