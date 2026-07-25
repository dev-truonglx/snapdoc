# i18n Implementation - Refactoring Guide for Remaining Components

## Status
- ✅ i18next infrastructure setup complete
- ✅ Translation files created (English + Vietnamese)
- ✅ Settings.tsx refactored with i18n
- ⏳ 11 remaining components need refactoring

## Files Remaining to Refactor

| File | Estimated Strings | Complexity | Priority |
|------|-------------------|-----------|----------|
| CaptureBar.tsx | 20+ | Medium | High |
| editor/Toolbar.tsx | 30+ | High | High |
| QuickToolbar.tsx | 12+ | Low | Medium |
| StitchDialog.tsx | 18+ | Low | Medium |
| VideoTrimmer.tsx | 25+ | Low | Medium |
| history/HistoryToolbar.tsx | 12+ | Low | Medium |
| editor/Editor.tsx | 6+ | Low | Low |
| history/HistoryItemCard.tsx | varies | Low | Low |
| RecordingIndicator.tsx | varies | Low | Low |
| UpdateWindow.tsx | varies | Low | Low |
| AnnotationStage.tsx | varies | Low | Low |

## Refactoring Pattern

For each file, follow this pattern:

### 1. Add useTranslation hook
```typescript
import { useTranslation } from 'react-i18next';

export default function MyComponent() {
  const { t } = useTranslation();
  // ...
}
```

### 2. Move string constants into component
```typescript
// Before: At module level
const LABELS = [
  { id: "quick", label: "Chụp nhanh" },
  { id: "full", label: "Chụp toàn màn hình" },
];

// After: Inside component after useState
const LABELS = [
  { id: "quick", label: t("shortcuts.quick") },
  { id: "full", label: t("shortcuts.full") },
];
```

### 3. Replace JSX strings
```typescript
// Before
<button>Lưu file</button>

// After
<button>{t("common.save")}</button>
```

### 4. Handle attributes
```typescript
// Before
<div title="Gợi ý">Content</div>

// After
<div title={t("common.hint")}>Content</div>
```

## Adding New Translation Keys

1. Add to `/src/locales/vi/translation.json` (Vietnamese)
2. Add to `/src/locales/en/translation.json` (English)
3. Use consistent namespace structure:
   ```json
   {
     "feature": {
       "action": "Label",
       "hint": "Help text"
     }
   }
   ```

## Example: CaptureBar.tsx Refactor

### Before
```typescript
const OUTPUTS: { id: OutputMode; label: string }[] = [
  { id: "editor",    label: "Mở editor"  },
  { id: "clipboard", label: "Clipboard"  },
  { id: "save",      label: "Lưu file"   },
];
```

### After
```typescript
export default function CaptureBar() {
  const { t } = useTranslation();
  
  const OUTPUTS: { id: OutputMode; label: string }[] = [
    { id: "editor",    label: t("outputs.editor")    },
    { id: "clipboard", label: t("outputs.clipboard") },
    { id: "save",      label: t("outputs.save")      },
  ];
}
```

## Testing

After each refactor:
1. Run dev server: `npm run app:dev`
2. Navigate to component
3. Test both languages (English + Vietnamese)
4. Verify language switching works
5. Check for missing translation keys in console

## Translation Key Naming Convention

- Use lowercase with dots for nesting: `feature.action`
- Keep keys descriptive but concise
- Group related strings under same namespace
- Common namespaces: `common`, `settings`, `tools`, `capture`, `editor`, etc.

## Language Selection Behavior

- Default language: Vietnamese (vi)
- Language preference saved to localStorage (`app-language`)
- Automatic fallback to English if key not found
- Language persists across app restarts

## Notes

- All UI strings should go through i18n (no hardcoded translations)
- Error messages from Rust backend should be caught and translated in React
- Comments and developer strings can remain in any language
- Consider using namespaces for large features (e.g., `editor`, `capture`)

## Future Enhancements

- Add language auto-detection based on system locale
- Support for additional languages (Chinese, Japanese, etc.)
- Right-to-left (RTL) language support
- Plural handling with i18next
- Date/time formatting based on locale
