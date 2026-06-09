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

module.exports = {
  purchaseEntryMasterId,
  purchaseJournalEntryMasterId,
  debitNoteEntryMasterId,
  debitNoteJournalEntryMasterId,
  toTallyOutboundMasterId,
};
