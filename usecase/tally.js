const moment = require("moment");
const { uuid } = require("uuidv4");
const simpleEncrypt = require("../utils/encrypt");

const INIT_PURCHASE_ENTRY = (date) => ({
  MasterID: uuid(),
  VoucherNumber: "", // mmh_mrc_refno
  VoucherDate: date, // mmh_mrc_dt
  Reference: "", // mmh_dist_bill_no
  ReferenceDate: date,
  PartyName: "", // supplier_name
  PartyCode: "", // supplier_id
  VoucherType: "", // Warehouse (Purchase) (List will be sent)
  DeliveryNoteNo: "",
  Voucher_Total: "", // Total Amount (internal)
  DeliveryNoteDate: "",
  DispatchThrough: "",
  Destination: "",
  CarrierName: "",
  LRNo: "",
  LRDate: "",
  MotorVehicleNo: "",
  OrderNo: "",
  OrderDate: "",
  TermsOfPayment: "",
  OtherReferences: "",
  TermsOfDelivery: "",
  PlaceOfSupply: "",
  IsInvoice: "",
  IsDeleted: "",
  BuyerName: "", // supplier_name
  BuyerAlias: "",
  BuyerGSTIN: "", // supplier_gstn
  BuyerAddress: "",
  BuyerPinCode: "",
  BuyerState: " ",
  BuyerCountryName: "India",
  BuyerEmail: "",
  BuyerMobile: "",
  ConsigneeName: "Dailyneeds Department Store", // Dailyneeds Department Store
  ConsigneeGSTIN: "34AAJFD4987C1ZD", // 34AAJFD79873
  ConsigneeAddress: ",",
  ConsigneePinCode: "",
  ConsigneeState: "Puducherry",
  ConsigneeCountryName: "India",
  VoucherCostCentre: "",
  Narration: "", // Narration from internal
  EWayBillDetails: "",
  EInvoiceDetails: "",
  item_total: "",
  ledgerentries: [],
});

const INIT_JOURNAL_ENTRY = (date) => ({
  MasterID: uuid(),
  VoucherNumber: "",
  VoucherDate: date,
  Reference: "",
  ReferenceDate: date,
  PartyName: "",
  VoucherType: "Journal",
  DeliveryNoteNo: "",
  Voucher_Total: "",
  DeliveryNoteDate: "",
  DispatchDocNo: "",
  DispatchThrough: "",
  Destination: "",
  CarrierName: "",
  LRNo: "",
  LRDate: "",
  MotorVehicleNo: "",
  OrderNo: "",
  OrderDate: "",
  TermsOfPayment: "",
  OtherReferences: "",
  TermsOfDelivery: "",
  Place_of_Supply: "",
  IsInvoice: "No",
  BuyerName: "",
  BuyerAlias: "",
  BuyerGSTIN: "",
  BuyerAddress: "",
  BuyerPinCode: "",
  BuyerState: "",
  BuyerCountryName: "",
  Buyer_Registration_Type: "",
  BuyerEmail: "",
  BuyerMobile: "",
  ConsigneeName: "",
  ConsigneeAddress: "",
  ConsigneeGSTIN: "",
  ConsigneeTallyGroup: "",
  ConsigneePinCode: "",
  ConsigneeState: "",
  ConsigneeCountryName: "",
  VoucherCostCentre: "",
  Consignee_Registration_Type: "Unregistered/Consumer",
  Narration: "",
  PurOrder: "",
  PurOrderID: "",
  WorkOrder: "",
  WorkOrderID: "",
  ledgerentries: [],
});

const shouldShowIGST = (supplier_gstn) => {
  if (
    !supplier_gstn ||
    supplier_gstn == "" ||
    supplier_gstn == 0 ||
    supplier_gstn?.startsWith("34")
  ) {
    return false;
  }

  return true;
};

const GET_LEDGER = ({
  LedgerName = "",
  LedgerGroup = "",
  LedgerAmount = "",
  IsDeemedPositive = "",
  GSTClassification = "",
  IGSTRate = "",
  BillsAllocation = "",
}) => {
  return {
    LedgerName,
    LedgerGroup,
    LedgerAmount,
    IsDeemedPositive,
    GSTClassification,
    IGSTRate,
    IsPartyLedger: "No",
    BillsAllocation,
    CategoryAllocation: "",
    LedgerDescription: "",
    BillRefType: "",
  };
};

const GET_JOURNAL_LEDGER = ({
  LedgerName = "",
  Amount = "",
  GroupName = "",
  IsDeemedPositive = "",
  IsPartyLedger = "",
  GSTRate = "",
  HSNCode = "",
  Cess_Rate = "",
  BillAllocations = [],
  CategoryAllocation = [],
}) => ({
  LedgerName,
  Amount,
  GroupName,
  IsDeemedPositive,
  IsPartyLedger,
  GSTRate,
  HSNCode,
  Cess_Rate,
  BillAllocations,
  CategoryAllocation,
});

class TallyUsecase {
  constructor(tallyRepo, purchaseUsecase) {
    this.tallyRepo = tallyRepo;
    this.purchaseUsecase = purchaseUsecase;
  }

  async getPurchase(from_date, to_date) {
    try {
      let formatted_from_date = moment(from_date, "MM-DD-YYYY").format(
        "YYYY-MM-DD"
      );
      let formatted_to_date = moment(to_date, "MM-DD-YYYY").format(
        "YYYY-MM-DD"
      );

      const filters = {
        from_date: formatted_from_date,
        to_date: formatted_to_date,
        is_approved: 1,
      };

      const data = await this.purchaseUsecase.getAllPurchases(filters);

      if (data.code === 200) {
        const tallyData = data.data.flatMap((purchase) => {
          const purchaseEntry = INIT_PURCHASE_ENTRY(
            moment(purchase.mmh_mrc_dt).format("YYYYMMDD")
          );

          purchaseEntry.MasterID = simpleEncrypt(
            `${purchase.purchase_id}-purchase-entry`
          );
          purchaseEntry.VoucherNumber = purchase.mmh_mrc_refno;
          purchaseEntry.Reference = purchase.mmh_dist_bill_no;
          purchaseEntry.PartyName = purchase.supplier_name;
          purchaseEntry.PartyCode = purchase.supplier_id;
          purchaseEntry.BuyerName = purchase.supplier_name;
          purchaseEntry.BuyerGSTIN = purchase.supplier_gstn;
          purchaseEntry.VoucherType = "Purchase";
          purchaseEntry.VoucherCostCentre = purchase.outlet_name; //TODO
          purchaseEntry.Voucher_Total = purchase.total_amount;

          purchaseEntry.Narration = purchase.narration;

          purchaseEntry.ledgerentries.push(
            GET_LEDGER({
              LedgerName: purchase.supplier_name,
              LedgerAmount: purchase.total_amount,
              IsDeemedPositive: "No",
              BillsAllocation: [
                {
                  AgstType: "New Ref",
                  Reference: purchase.mmh_dist_bill_no,
                  CreditPeriod: 0,
                  Amount: purchase.total_amount,
                },
              ],
            })
          );

          if (!shouldShowIGST(purchase.supplier_gstn)) {
            purchase.sgst.forEach((item) => {
              if (item.PERC === 0) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `Local GST Purchase Nil Rated`,
                    LedgerAmount: item.TAXABLE,
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "Yes",
                    LedgerGroup: "$$GroupPurchase",
                    IGSTRate: 0,
                  })
                );

                return;
              }

              if (item.TAXABLE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `LOCAL PURCHASE ${item.PERC * 2}%`,
                    LedgerAmount: item.TAXABLE,
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "Yes",
                    LedgerGroup: "$$GroupPurchase",
                    IGSTRate: item.PERC * 2,
                  })
                );
              }

              if (item.VALUE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `CGST ${item.PERC}% INPUT`,
                    LedgerAmount: item.VALUE,
                    IsDeemedPositive: "Yes",
                  })
                );
              }

              if (item.VALUE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `SGST ${item.PERC}% INPUT`,
                    LedgerAmount: item.VALUE,
                    IsDeemedPositive: "Yes",
                  })
                );
              }
            });
          } else {
            purchase.igst.forEach((item) => {
              if (item.PERC === 0) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `IGST GST Purchase Nil Rated`,
                    LedgerAmount: item.TAXABLE,
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "Yes",
                    LedgerGroup: "$$GroupPurchase",
                    IGSTRate: 0,
                  })
                );

                return;
              }

              if (item.TAXABLE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `IGST PURCHASE ${item.PERC * 2}%`,
                    LedgerAmount: item.TAXABLE,
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "Yes",
                    LedgerGroup: "$$GroupPurchase",
                    IGSTRate: item.PERC * 2,
                  })
                );
              }

              if (item.VALUE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `IGST ${item.PERC}% INPUT`,
                    LedgerAmount: item.VALUE,
                    IsDeemedPositive: "Yes",
                  })
                );
              }
            });
          }

          if (purchase.cash_discount && purchase.cash_discount != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Cash Discount`,
                LedgerAmount: purchase.cash_discount,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.scheme_difference && purchase.scheme_difference != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Scheme Difference`,
                LedgerAmount: purchase.scheme_difference,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.cost_difference && purchase.cost_difference != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Cost Difference`,
                LedgerAmount: purchase.cost_difference,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.due && purchase.due != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Due`,
                LedgerAmount: purchase.due,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.freight_charges && purchase.freight_charges != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Freight Charges`,
                LedgerAmount: purchase.freight_charges,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.round_off && purchase.round_off != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Round Off`,
                LedgerAmount: purchase.round_off,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (
            purchase.supplier_credit_note &&
            purchase.supplier_credit_note != 0
          ) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Supplier Credit Note`,
                LedgerAmount: purchase.round_off,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.tot_gst_cess_amt && purchase.tot_gst_cess_amt != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `CESS 12% INPUT`,
                LedgerAmount: purchase.tot_gst_cess_amt,
                IsDeemedPositive: "Yes",
              })
            );
          }

          let journalEntry = null;

          if (purchase.jv_ledger === 1) {
            const journalEntry = INIT_JOURNAL_ENTRY(
              moment(purchase.mmh_mrc_dt).format("YYYYMMDD")
            );

            journalEntry.MasterID = simpleEncrypt(
              `${purchase.purchase_id}-journal-entry`
            );
            journalEntry.VoucherNumber = purchase.mmh_mrc_refno;
            journalEntry.Reference = purchase.mmh_dist_bill_no;
            journalEntry.ReferenceDate = moment(purchase.dist_bill_dt).format(
              "YYYY-MM-DD"
            );
            journalEntry.PartyName = purchase.supplier_name;
            journalEntry.Voucher_Total = purchase.total_amount;
            journalEntry.Narration = purchase.narration;

            journalEntry.ledgerentries.push(
              GET_JOURNAL_LEDGER({
                LedgerName: purchase.supplier_name,
                Amount: purchase.total_amount,
                IsDeemedPositive: "Yes",
                BillAllocations: [
                  {
                    AgstType: "New Ref",
                    Reference: purchase.mmh_dist_bill_no,
                    Amount: purchase.total_amount,
                  },
                ],
                CategoryAllocation: [
                  {
                    Name: "Primary Cost Category",
                    Amount: purchase.total_amount,
                    CostCentreAllocations: [
                      {
                        Name: purchase.outlet_name,
                        Amount: purchase.total_amount,
                      },
                    ],
                  },
                ],
              })
            );

            journalEntry.ledgerentries.push(
              GET_JOURNAL_LEDGER({
                LedgerName: "Ready To Pay",
                Amount: purchase.total_amount,
                GroupName: "Bank Accounts",
                IsDeemedPositive: "No",
                IsPartyLedger: "Yes",
                CategoryAllocation: [
                  {
                    Name: "Primary Cost Category",
                    Amount: purchase.total_amount,
                    CostCentreAllocations: [
                      {
                        Name: purchase.outlet_name,
                        Amount: purchase.total_amount,
                      },
                    ],
                  },
                ],
              })
            );
          }

          if (journalEntry) {
            return [purchaseEntry, journalEntry];
          }

          return [purchaseEntry];
        });

        return { error: "false", data: tallyData };
      }

      return { error: "true", data: [] };
    } catch (err) {
      throw err;
    }
  }
}

module.exports = (tallyRepo, purchaseUsecase) => {
  return new TallyUsecase(tallyRepo, purchaseUsecase);
};
