const Joi = require("@hapi/joi");

const billsAllocationSchema = Joi.object({
  AgstType: Joi.string().allow("", null),
  Reference: Joi.string().allow("", null),
  CreditPeriod: Joi.alternatives().try(Joi.number(), Joi.string()).allow(null),
  Amount: Joi.alternatives().try(Joi.number(), Joi.string()).allow(null),
}).unknown(true);

const categoryAllocationSchema = Joi.object({
  Category: Joi.string().allow("", null),
  IsDeemedPositive: Joi.string().allow("", null),
  isDeeemedPositive: Joi.string().allow("", null),
  CostCentreAllocation: Joi.array()
    .items(
      Joi.object({
        Name: Joi.string().allow("", null),
        Amount: Joi.alternatives().try(Joi.number(), Joi.string()).allow(null),
      }).unknown(true)
    )
    .allow(null),
}).unknown(true);

const ledgerEntrySchema = Joi.object({
  LedgerName: Joi.string().allow("", null),
  LedgerGroup: Joi.string().allow("", null),
  GroupName: Joi.string().allow("", null),
  LedgerAmount: Joi.alternatives().try(Joi.number(), Joi.string()).allow("", null),
  IsDeemedPositive: Joi.string().allow("", null),
  IsPartyLedger: Joi.string().allow("", null),
  GSTClassification: Joi.string().allow("", null),
  IGSTRate: Joi.alternatives().try(Joi.number(), Joi.string()).allow("", null),
  HSNCode: Joi.string().allow("", null),
  Cess_Rate: Joi.alternatives().try(Joi.number(), Joi.string()).allow("", null),
  BillsAllocation: Joi.alternatives()
    .try(Joi.array().items(billsAllocationSchema), Joi.string().allow(""))
    .allow(null),
  CategoryAllocation: Joi.alternatives()
    .try(Joi.array().items(categoryAllocationSchema), Joi.string().allow(""))
    .allow(null),
  LedgerDescription: Joi.alternatives()
    .try(Joi.array(), Joi.string().allow(""))
    .allow(null),
  BillRefType: Joi.string().allow("", null),
  AppropriateOnValue: Joi.string().allow("", null),
}).unknown(true);

/** Matches a single object from GET /tally/purchase `data[]`. */
const tallyPurchaseDataSchema = Joi.object({
  MasterID: Joi.string().required(),
  VoucherNumber: Joi.string().required(),
  VoucherDate: Joi.alternatives().try(Joi.string(), Joi.number()).allow("", null),
  Reference: Joi.string().allow("", null),
  ReferenceDate: Joi.alternatives().try(Joi.string(), Joi.number()).allow("", null),
  PartyName: Joi.string().allow("", null),
  PartyCode: Joi.string().allow("", null),
  VoucherType: Joi.string().allow("", null),
  VoucherBaseType: Joi.string().allow("", null),
  DeliveryNoteNo: Joi.string().allow("", null),
  Voucher_Total: Joi.alternatives().try(Joi.number(), Joi.string()).allow("", null),
  DeliveryNoteDate: Joi.string().allow("", null),
  DispatchThrough: Joi.string().allow("", null),
  Destination: Joi.string().allow("", null),
  CarrierName: Joi.string().allow("", null),
  LRNo: Joi.string().allow("", null),
  LRDate: Joi.string().allow("", null),
  MotorVehicleNo: Joi.string().allow("", null),
  OrderNo: Joi.string().allow("", null),
  OrderDate: Joi.string().allow("", null),
  TermsOfPayment: Joi.string().allow("", null),
  OtherReferences: Joi.string().allow("", null),
  TermsOfDelivery: Joi.string().allow("", null),
  PlaceOfSupply: Joi.string().allow("", null),
  IsInvoice: Joi.string().allow("", null),
  IsDeleted: Joi.string().allow("", null),
  BuyerGSTRegistrationType: Joi.string().allow("", null),
  BuyerName: Joi.string().allow("", null),
  BuyerAlias: Joi.string().allow("", null),
  BuyerGSTIN: Joi.string().allow("", null),
  BuyerAddress: Joi.string().allow("", null),
  BuyerPinCode: Joi.string().allow("", null),
  BuyerState: Joi.string().allow("", null),
  BuyerCountryName: Joi.string().allow("", null),
  BuyerEmail: Joi.string().allow("", null),
  BuyerMobile: Joi.string().allow("", null),
  ConsigneeName: Joi.string().allow("", null),
  ConsigneeGSTIN: Joi.string().allow("", null),
  ConsigneeAddress: Joi.string().allow("", null),
  ConsigneePinCode: Joi.string().allow("", null),
  ConsigneeState: Joi.string().allow("", null),
  ConsigneeCountryName: Joi.string().allow("", null),
  VoucherCostCentre: Joi.string().allow("", null),
  Narration: Joi.string().allow("", null),
  EWayBillDetails: Joi.string().allow("", null),
  EInvoiceDetails: Joi.string().allow("", null),
  item_total: Joi.alternatives().try(Joi.number(), Joi.string()).allow("", null),
  SVViewName: Joi.string().allow("", null),
  DispatchDocNo: Joi.string().allow("", null),
  GSTREGISTRATIONTYPE: Joi.string().allow("", null),
  ledgerentries: Joi.array().items(ledgerEntrySchema).default([]),
}).unknown(true);

const gstTallyPurchaseRequestSchema = Joi.object({
  action: Joi.string().valid("create", "update", "delete").required(),
  data: tallyPurchaseDataSchema.required(),
});

module.exports = {
  tallyPurchaseDataSchema,
  gstTallyPurchaseRequestSchema,
};
