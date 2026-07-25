import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import viTranslation from '../locales/vi/translation.json';
import enTranslation from '../locales/en/translation.json';

// Get saved language from localStorage, default to 'vi'
const getSavedLanguage = (): string => {
  if (typeof window === 'undefined') return 'vi';
  const saved = localStorage.getItem('app-language');
  return saved || 'vi';
};

i18next
  .use(initReactI18next)
  .init({
    resources: {
      vi: { translation: viTranslation },
      en: { translation: enTranslation },
    },
    lng: getSavedLanguage(),
    fallbackLng: 'en',
    interpolation: {
      escapeValue: false, // React already handles XSS
    },
    ns: ['translation'],
    defaultNS: 'translation',
  });

export default i18next;
