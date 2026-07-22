import {
  SYMBOL_DB_MISSING_MESSAGE,
  isSymbolDatabaseAvailable,
} from '../lib/symbols';

/** Empty state for the symbol database.
 *
 *  The per-ROM-family symbol tables are generated from the user's own
 *  pret decomp checkout and are deliberately not distributed with this
 *  repository (they are bulk extracted game content). When they are
 *  absent every symbol lookup returns null and the editor falls back to
 *  synthetic labels like "flag_0x2B" - correct, but confusing unless we
 *  say why. This banner says why, once, next to the project identity.
 *
 *  Renders nothing when at least one family database is present. */
export function SymbolDbNotice() {
  if (isSymbolDatabaseAvailable()) return null;
  return (
    <div
      className="symbol-db-notice"
      role="status"
      data-testid="symbol-db-notice"
      style={{
        border: '1px solid #b8860b',
        borderRadius: 4,
        padding: '0.6rem 0.75rem',
        margin: '0.5rem 0',
        fontSize: '0.85rem',
        lineHeight: 1.45,
      }}
    >
      <strong>Symbol names unavailable.</strong>{' '}
      {SYMBOL_DB_MISSING_MESSAGE} Until then, flags, vars, songs, species,
      moves, abilities and items show synthetic ids instead of their pret
      constant names.
    </div>
  );
}
