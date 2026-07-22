export {
  SIGNATURE_ENTRY_SCHEMA,
  SIGNATURE_FILE_SCHEMA,
  type BuildMarker,
  type SignatureEntry,
  type SignatureFile,
  type SignatureKind,
} from './schema.js';

export {
  SignatureDbLoadError,
  loadSignatureDb,
  type SignatureDb,
  type SignatureFileLoadError,
} from './loader.js';

export {
  matchSignatures,
  type MatchReason,
  type MatchReasonKind,
  type MatchSignaturesArgs,
  type SignatureMatch,
} from './matcher.js';
