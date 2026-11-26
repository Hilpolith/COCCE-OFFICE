export type OfficeLanguage = 'en' | 'sw';

export const OFFICE_LANGUAGE_STORAGE_KEY = 'cocce-office-language-v1';
export const OFFICE_LANGUAGE_OPTIONS: ReadonlyArray<{ code: OfficeLanguage; label: string; nativeName: string }> = [
  { code: 'en', label: 'English', nativeName: 'English' },
  { code: 'sw', label: 'Swahili', nativeName: 'Kiswahili' },
];

const messages = {
  en: { overview: 'Overview', preferences: 'Preferences', docs: 'Docs', sheets: 'Sheets', slides: 'Slides', html: 'HTML', markdown: 'Markdown', pdf: 'PDF', drive: 'Drive', vault: 'Vault', spaces: 'Spaces', documents: 'Documents', chats: 'Chats', aiChat: 'AI Chat', cocceAI: 'COCCE AI', officeSuites: 'Office suites', documentEditor: 'Document editor', editorContext: 'EDITOR CONTEXT', personalSpace: 'Personal space · this browser', localOfficeSpace: 'Local Office space · this browser', officeLanguage: 'Application language', languageHelp: 'Uses the same primary language choices as COCCE Super App. Your choice is saved on this device and does not change your account or backend.', preferencesTitle: 'Make it yours', preferencesLead: 'Language, theme and accent choices are saved in this browser.', surfaceAppearance: 'Surface appearance', surfaceHelp: 'Choose a frosted or solid workspace surface.', liquidGlassThemes: 'Liquid Glass themes', themeHelp: 'Choose a color atmosphere for this workspace.', accentColor: 'Accent color', accentHelp: 'Applied to highlights and focus states.', connectionStatus: 'Connection status', connectionHelp: 'Office Team collaboration is server-backed; most productivity tools remain browser-local.', localSettings: 'Local settings', savedOnDevice: 'Saved on this device', deviceOnly: 'Device only', newDocument: 'New document', importDocx: 'Import DOCX', importSource: 'Import HTML / MD / TXT', frostedGlass: 'Frosted glass', solidSurfaces: 'Solid surfaces' },
  sw: { overview: 'Muhtasari', preferences: 'Mipangilio', docs: 'Nyaraka', sheets: 'Majedwali', slides: 'Mawasilisho', html: 'HTML', markdown: 'Markdown', pdf: 'PDF', drive: 'Hifadhi', vault: 'Hazina', spaces: 'Nafasi', documents: 'Nyaraka', chats: 'Mazungumzo', aiChat: 'Mazungumzo ya AI', cocceAI: 'COCCE AI', officeSuites: 'Vifaa vya Ofisi', documentEditor: 'Kihariri cha nyaraka', editorContext: 'MUKTADHA WA KIHARIRI', personalSpace: 'Nafasi binafsi · kifaa hiki', localOfficeSpace: 'Nafasi ya Ofisi · kifaa hiki', officeLanguage: 'Lugha ya programu', languageHelp: 'Hutumia chaguo kuu za lugha zinazotumiwa na COCCE Super App. Chaguo lako huhifadhiwa kwenye kifaa hiki na halibadilishi akaunti au mfumo wa nyuma.', preferencesTitle: 'Binafsisha programu', preferencesLead: 'Lugha, mandhari na rangi huhifadhiwa kwenye kivinjari hiki.', surfaceAppearance: 'Muonekano wa sehemu', surfaceHelp: 'Chagua muonekano wa kioo kilichofifishwa au sehemu thabiti.', liquidGlassThemes: 'Mandhari ya Liquid Glass', themeHelp: 'Chagua mwonekano wa rangi wa nafasi hii.', accentColor: 'Rangi ya msisitizo', accentHelp: 'Hutumika kwenye vivutio na viashiria vya umakini.', connectionStatus: 'Hali ya muunganisho', connectionHelp: 'Ushirikiano wa Office Team hutumia seva; zana nyingi za uzalishaji hubaki kwenye kivinjari.', localSettings: 'Mipangilio ya kifaa', savedOnDevice: 'Imehifadhiwa kwenye kifaa hiki', deviceOnly: 'Kifaa hiki pekee', newDocument: 'Hati mpya', importDocx: 'Ingiza DOCX', importSource: 'Ingiza HTML / MD / TXT', frostedGlass: 'Kioo kilichofifishwa', solidSurfaces: 'Sehemu thabiti' }
} as const;

export type OfficeMessageKey = keyof typeof messages.en;
export function officeText(language: OfficeLanguage, key: OfficeMessageKey): string { return messages[language][key] ?? messages.en[key]; }
export function readOfficeLanguage(storage: Pick<Storage, 'getItem'>): OfficeLanguage {
  try { const raw = storage.getItem(OFFICE_LANGUAGE_STORAGE_KEY); if (raw === 'en' || raw === 'sw') return raw; } catch { /* Safe English fallback. */ }
  return 'en';
}
export function writeOfficeLanguage(storage: Pick<Storage, 'setItem'>, language: OfficeLanguage): void {
  if (language !== 'en' && language !== 'sw') throw new TypeError('Unsupported COCCE Office language.');
  try { storage.setItem(OFFICE_LANGUAGE_STORAGE_KEY, language); } catch { throw new Error('Unable to save the language preference on this device.'); }
}