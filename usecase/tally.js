const moment = require("moment");
const { uuid } = require("uuidv4");

const INIT_JOURNAL_ENTRY = (date) => ({
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
        const tallyData = data.data.map((purchase) => {
          const journalEntry = INIT_JOURNAL_ENTRY(purchase.mmh_mrc_dt);

          journalEntry.VoucherNumber = purchase.mmh_mrc_refno;
          journalEntry.Reference = purchase.mmh_dist_bill_no;
          journalEntry.PartyName = purchase.supplier_name;
          journalEntry.PartyCode = purchase.supplier_id;
          journalEntry.BuyerName = purchase.supplier_name;
          journalEntry.BuyerGSTIN = purchase.supplier_gstn;
          journalEntry.VoucherType = "Purchase";
          journalEntry.VoucherCostCentre = "outlet Name"; //TODO

          journalEntry.Narration = purchase.narration;

          journalEntry.ledgerentries.push(
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
                journalEntry.ledgerentries.push(
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
                journalEntry.ledgerentries.push(
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
                journalEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `CGST ${item.PERC}% INPUT`,
                    LedgerAmount: item.VALUE,
                    IsDeemedPositive: "Yes",
                  })
                );
              }

              if (item.VALUE) {
                journalEntry.ledgerentries.push(
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
                journalEntry.ledgerentries.push(
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
                journalEntry.ledgerentries.push(
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
                journalEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `IGST ${item.PERC}% INPUT`,
                    LedgerAmount: item.VALUE,
                    IsDeemedPositive: "Yes",
                  })
                );
              }
            });
          }

          if (purchase.cash_discount) {
            journalEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Cash Discount`,
                LedgerAmount: purchase.cash_discount,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.scheme_difference) {
            journalEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Scheme Difference`,
                LedgerAmount: purchase.scheme_difference,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.cost_difference) {
            journalEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Cost Difference`,
                LedgerAmount: purchase.cost_difference,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.due) {
            journalEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Due`,
                LedgerAmount: purchase.due,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.freight_charges) {
            journalEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Freight Charges`,
                LedgerAmount: purchase.freight_charges,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.round_off) {
            journalEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Round Off`,
                LedgerAmount: purchase.round_off,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.supplier_credit_note) {
            journalEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Supplier Credit Note`,
                LedgerAmount: purchase.round_off,
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.tot_gst_cess_amt && purchase.tot_gst_cess_amt != 0) {
            journalEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `CESS 12% INPUT`,
                LedgerAmount: purchase.tot_gst_cess_amt,
                IsDeemedPositive: "Yes",
              })
            );
          }

          return journalEntry;
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
