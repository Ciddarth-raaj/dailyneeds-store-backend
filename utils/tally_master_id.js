const simpleEncrypt = require("./encrypt");

function purchaseEntryMasterId(purchaseId) {
  return `${purchaseId}-purchase-entry`;
}

function purchaseJournalEntryMasterId(purchaseId) {
  return `${purchaseId}-journal-entry`;
}

function debitNoteEntryMasterId(debitNoteId) {
  return `${debitNoteId}-purchase-entry`;
}

function debitNoteJournalEntryMasterId(debitNoteId) {
  return `${debitNoteId}-journal-entry`;
}

function isRecordNew(isNew) {
  return isNew === true || isNew === 1 || isNew === "1";
}

/** Encrypt legacy master ids only when sending to Tally GET APIs. */
function toTallyOutboundMasterId(plainMasterId, isNew) {
  if (isRecordNew(isNew)) {
    return plainMasterId;
  }
  return simpleEncrypt(plainMasterId);
}

/**
 * The purchase id inside a purchase-entry MasterID the export sent to
 * Tally - plain ("123-purchase-entry", new records) or encrypted (legacy
 * records) - or null when it is neither.
 */
function purchaseIdFromMasterId(masterId) {
  const text = String(masterId == null ? "" : masterId).trim();
  if (!text) return null;
  const plain = /^(\d+)-purchase-entry$/;
  let m = text.match(plain);
  if (!m) {
    try {
      m = simpleEncrypt.decrypt(text).match(plain);
    } catch (e) {
      m = null;
    }
  }
  return m ? Number(m[1]) : null;
}

module.exports = {
  purchaseIdFromMasterId,
  purchaseEntryMasterId,
  purchaseJournalEntryMasterId,
  debitNoteEntryMasterId,
  debitNoteJournalEntryMasterId,
  toTallyOutboundMasterId,
};
