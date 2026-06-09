const moment = require("moment");
const { uuid } = require("uuidv4");
const { purchaseEntryMasterId } = require("../utils/tally_master_id");

const OUTLET_CASH_ID_MAP = {
  4: "Dn1",
  3: "Dn2",
  5: "Dn3",
  6: "Dn4",
  7: "Dn5",
};

const INIT_JOURNAL_ENTRY_OLD = (date) => ({
  MasterID: uuid(),
  SellerGSTIN: null,
  VoucherState: "Puducherry",
  ShipFromState: "Puducherry",
  VoucherNumber: null,
  VoucherDate: date,
  VoucherType: "Journal",
  VoucherBaseType: "Journal ",
  Reference: null,
  ReferenceDate: date,
  IsCancelled: null,
  PartyName: null,
  GSTREGISTRATIONTYPE: null,
  Voucher_Total: null,
  DeliveryNoteNo: null,
  DeliveryNoteDate: null,
  DispatchDocNo: null,
  DispatchThrough: null,
  Destination: null,
  CarrierName: null,
  LRNo: null,
  LRDate: null,
  MotorVehicleNo: null,
  OrderNo: "",
  OrderDate: "",
  TermsOfPayment: null,
  OtherReferences: null,
  TermsOfDelivery: null,
  PlaceOfSupply: "Puducherry",
  IsInvoice: "No",
  IsDeleted: "No",
  Narration: null,
  VoucherCostCentre: null,
  ledgerentries: [],
});

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
  PlaceOfSupply: "Puducherry",
  IsInvoice: "Yes",
  IsDeleted: "",
  BuyerGSTRegistrationType: "",
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
  SVViewName: "InvVchView",
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
  BuyerGSTRegistrationType: "",
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
  SVViewName: "AccVchView",
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
  LedgerAmount = "",
  GroupName = "",
  IsDeemedPositive = "",
  IsPartyLedger = "",
  IGSTRate = "",
  HSNCode = "",
  Cess_Rate = "",
  BillsAllocation = [],
  CategoryAllocation = [],
}) => ({
  LedgerName,
  LedgerAmount,
  GroupName,
  IsDeemedPositive,
  IsPartyLedger,
  IGSTRate,
  HSNCode,
  Cess_Rate,
  BillsAllocation,
  CategoryAllocation,
});

const OUTLET_VOUCHER_TYPE_MAP = {
  2: "Purchase",
  3: "PurchaseDN2",
  4: "PurchaseDN1",
  5: "PurchaseDN3",
  6: "PurchaseDN4",
  7: "PurchaseDN5",
};

const OUTLET_VOUCHER_TYPE_MAP_DEBIT_NOTE = {
  2: "Debit Note",
  3: "Debit Note DN2",
  4: "Debit Note DN1",
  5: "Debit Note DN3",
  6: "Debit Note DN4",
  7: "Debit Note DN5",
};

class TallyUsecase {
  constructor(tallyRepo, purchaseUsecase, accountsUsecase, debitNoteUsecase) {
    this.tallyRepo = tallyRepo;
    this.purchaseUsecase = purchaseUsecase;
    this.accountsUsecase = accountsUsecase;
    this.debitNoteUsecase = debitNoteUsecase;
  }

  async getDebitNote(from_date, to_date) {
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

      const data = await this.debitNoteUsecase.getAll(filters);

      if (data.code === 200) {
        const tallyData = data.data.flatMap((purchase) => {
          const purchaseEntry = INIT_PURCHASE_ENTRY(
            purchase.mmh_dist_bill_dt
              ? moment(purchase.mmh_dist_bill_dt).format("YYYYMMDD")
              : ""
          );

          purchaseEntry.VoucherDate = moment(purchase.mprh_pr_dt).format(
            "YYYYMMDD"
          );
          purchaseEntry.MasterID = `${purchase.debit_note_id}-purchase-entry`;
          purchaseEntry.VoucherNumber = purchase.mprh_pr_refno;
          purchaseEntry.Reference = purchase.mmh_dist_bill_no || "";
          purchaseEntry.PartyName = purchase.supplier_name;
          purchaseEntry.PartyCode = purchase.supplier_id;
          purchaseEntry.BuyerName = purchase.supplier_name;
          purchaseEntry.BuyerGSTRegistrationType = purchase.supplier_gstn
            ? "Regular"
            : "";
          purchaseEntry.BuyerGSTIN = purchase.supplier_gstn;
          purchaseEntry.VoucherType =
            OUTLET_VOUCHER_TYPE_MAP_DEBIT_NOTE[purchase.outlet_id] ||
            "Debit Note";
          purchaseEntry.VoucherCostCentre = purchase.outlet_name;
          purchaseEntry.Voucher_Total = parseFloat(
            purchase.total_amount
          ).toFixed(2);

          purchaseEntry.Narration = purchase.narration;

          if (purchase.mmh_dist_bill_no) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: purchase.supplier_name,
                LedgerAmount: parseFloat(purchase.total_amount).toFixed(2),
                IsDeemedPositive: "Yes",
                BillsAllocation: [
                  {
                    AgstType: "Agst Ref",
                    Reference: purchase.mmh_dist_bill_no || "",
                    CreditPeriod: 0,
                    Amount: parseFloat(purchase.total_amount * -1).toFixed(2),
                  },
                ],
              })
            );
          } else {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: purchase.mprh_pr_refno,
                LedgerAmount: parseFloat(purchase.total_amount).toFixed(2),
                IsDeemedPositive: "Yes",
                BillsAllocation: [
                  {
                    AgstType: "New Ref",
                    Reference: purchase.mprh_pr_refno || "",
                    CreditPeriod: 0,
                    Amount: parseFloat(purchase.total_amount * -1).toFixed(2),
                  },
                ],
              })
            );
          }

          if (!shouldShowIGST(purchase.supplier_gstn)) {
            purchase.sgst.forEach((item) => {
              if (item.PERC === 0) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `Local GST Purchase Nil Rated`,
                    LedgerAmount: parseFloat(item.TAXABLE).toFixed(2),
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "No",
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
                    LedgerAmount: parseFloat(item.TAXABLE).toFixed(2),
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "No",
                    LedgerGroup: "$$GroupPurchase",
                    IGSTRate: item.PERC * 2,
                  })
                );
              }

              if (item.VALUE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `CGST ${item.PERC}% INPUT`,
                    LedgerAmount: parseFloat(item.VALUE).toFixed(2),
                    IsDeemedPositive: "No",
                  })
                );
              }

              if (item.VALUE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `SGST ${item.PERC}% INPUT`,
                    LedgerAmount: parseFloat(item.VALUE).toFixed(2),
                    IsDeemedPositive: "No",
                  })
                );
              }
            });
          } else {
            purchase.igst.forEach((item) => {
              if (item.PERC === 0) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `IGST Purchase Nil Rated`,
                    LedgerAmount: parseFloat(item.TAXABLE).toFixed(2),
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "No",
                    LedgerGroup: "$$GroupPurchase",
                    IGSTRate: 0,
                  })
                );

                return;
              }

              if (item.TAXABLE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `IGST PURCHASE ${item.PERC}%`,
                    LedgerAmount: parseFloat(item.TAXABLE).toFixed(2),
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "No",
                    LedgerGroup: "$$GroupPurchase",
                    IGSTRate: item.PERC,
                  })
                );
              }

              if (item.VALUE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `IGST ${item.PERC}% INPUT`,
                    LedgerAmount: parseFloat(item.VALUE).toFixed(2),
                    IsDeemedPositive: "No",
                  })
                );
              }
            });
          }

          // if (purchase.tot_gst_cess_amt && purchase.tot_gst_cess_amt != 0) {
          //   purchaseEntry.ledgerentries.push(
          //     GET_LEDGER({
          //       LedgerName: `CESS 12% INPUT`,
          //       LedgerAmount: parseFloat(purchase.tot_gst_cess_amt).toFixed(2),
          //       IsDeemedPositive: "Yes",
          //     })
          //   );
          // }

          if (purchase.tcs_value && purchase.tcs_value != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `TCS @ 0.1%`,
                LedgerAmount: parseFloat(purchase.tcs_value).toFixed(2),
                IsDeemedPositive: "No",
              })
            );
          }

          if (purchase.scheme_difference && purchase.scheme_difference != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Scheme Difference`,
                LedgerAmount:
                  -1 * parseFloat(purchase.scheme_difference).toFixed(2),
                IsDeemedPositive: "No",
              })
            );
          }

          if (purchase.round_off && purchase.round_off != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Round Off`,
                LedgerAmount: parseFloat(purchase.round_off).toFixed(2),
                IsDeemedPositive: "No",
              })
            );
          }

          let journalEntry = null;

          if (purchase.jv_ledger == 1) {
            journalEntry = INIT_JOURNAL_ENTRY(
              moment(purchase.mmh_mrc_dt).format("YYYYMMDD")
            );

            journalEntry.MasterID = `${purchase.debit_note_id}-journal-entry`;
            journalEntry.VoucherNumber = purchase.mprh_pr_refno;
            journalEntry.Reference = purchase.mmh_dist_bill_no;
            journalEntry.BuyerGSTRegistrationType = purchase.supplier_gstn
              ? "Regular"
              : "";
            journalEntry.PartyName = purchase.supplier_name;
            journalEntry.BuyerGSTIN = purchase.supplier_gstn;
            journalEntry.Voucher_Total = parseFloat(
              purchase.total_amount
            ).toFixed(2);
            journalEntry.Narration = purchase.narration;

            journalEntry.ledgerentries.push(
              GET_JOURNAL_LEDGER({
                LedgerName: purchase.supplier_name,
                LedgerAmount: parseFloat(purchase.total_amount).toFixed(2),
                IsDeemedPositive: "No",
                LedgerGroup: "$$GroupSundryCreditors",
                BillsAllocation: [
                  {
                    AgstType: "New Ref",
                    Reference: purchase.mmh_dist_bill_no,
                    Amount: -1 * parseFloat(purchase.total_amount),
                  },
                ],
                CategoryAllocation: [
                  {
                    Category: "Primary Cost Category",
                    isDeeemedPositive: "Yes",
                    CostCentreAllocation: [
                      {
                        Name: purchase.outlet_name,
                        Amount: parseFloat(purchase.total_amount).toFixed(2),
                      },
                    ],
                  },
                ],
              })
            );

            journalEntry.ledgerentries.push(
              GET_JOURNAL_LEDGER({
                LedgerName: "Ready To Pay",
                LedgerAmount: parseFloat(purchase.total_amount).toFixed(2),
                GroupName: "Bank Accounts",
                IsDeemedPositive: "Yes",
                IsPartyLedger: "Yes",
                CategoryAllocation: [
                  {
                    Category: "Primary Cost Category",
                    isDeeemedPositive: "Yes",
                    CostCentreAllocation: [
                      {
                        Name: purchase.outlet_name,
                        Amount: parseFloat(purchase.total_amount).toFixed(2),
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

          purchaseEntry.MasterID = purchaseEntryMasterId(purchase.purchase_id);
          purchaseEntry.VoucherNumber = purchase.mmh_mrc_refno;
          purchaseEntry.Reference = purchase.mmh_dist_bill_no;
          purchaseEntry.PartyName = purchase.supplier_name;
          purchaseEntry.PartyCode = purchase.supplier_id;
          purchaseEntry.BuyerName = purchase.supplier_name;
          purchaseEntry.BuyerGSTRegistrationType = purchase.supplier_gstn
            ? "Regular"
            : "";
          purchaseEntry.BuyerGSTIN = purchase.supplier_gstn;
          purchaseEntry.VoucherType =
            OUTLET_VOUCHER_TYPE_MAP[purchase.outlet_id] || "Purchase";
          purchaseEntry.VoucherCostCentre = purchase.outlet_name;
          purchaseEntry.Voucher_Total = parseFloat(
            purchase.total_amount
          ).toFixed(2);

          purchaseEntry.Narration = purchase.narration;

          purchaseEntry.ledgerentries.push(
            GET_LEDGER({
              LedgerName: purchase.supplier_name,
              LedgerAmount: parseFloat(purchase.total_amount).toFixed(2),
              IsDeemedPositive: "No",
              BillsAllocation: [
                {
                  AgstType: "New Ref",
                  Reference: purchase.mmh_dist_bill_no,
                  CreditPeriod: 0,
                  Amount: parseFloat(purchase.total_amount).toFixed(2),
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
                    LedgerAmount: parseFloat(item.TAXABLE).toFixed(2),
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
                    LedgerAmount: parseFloat(item.TAXABLE).toFixed(2),
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
                    LedgerAmount: parseFloat(item.VALUE).toFixed(2),
                    IsDeemedPositive: "Yes",
                  })
                );
              }

              if (item.VALUE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `SGST ${item.PERC}% INPUT`,
                    LedgerAmount: parseFloat(item.VALUE).toFixed(2),
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
                    LedgerName: `IGST Purchase Nil Rated`,
                    LedgerAmount: parseFloat(item.TAXABLE).toFixed(2),
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
                    LedgerName: `IGST PURCHASE ${item.PERC}%`,
                    LedgerAmount: parseFloat(item.TAXABLE).toFixed(2),
                    GSTClassification: "Purchase Taxable",
                    IsDeemedPositive: "Yes",
                    LedgerGroup: "$$GroupPurchase",
                    IGSTRate: item.PERC,
                  })
                );
              }

              if (item.VALUE) {
                purchaseEntry.ledgerentries.push(
                  GET_LEDGER({
                    LedgerName: `IGST ${item.PERC}% INPUT`,
                    LedgerAmount: parseFloat(item.VALUE).toFixed(2),
                    IsDeemedPositive: "Yes",
                  })
                );
              }
            });
          }

          if (purchase.tot_gst_cess_amt && purchase.tot_gst_cess_amt != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `CESS 12% INPUT`,
                LedgerAmount: parseFloat(purchase.tot_gst_cess_amt).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.mmd_goods_tcs_amt && purchase.mmd_goods_tcs_amt != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `TCS @ 0.1%`,
                LedgerAmount: parseFloat(purchase.mmd_goods_tcs_amt).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.cash_discount && purchase.cash_discount != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Cash Discount`,
                LedgerAmount:
                  -1 * parseFloat(purchase.cash_discount).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.scheme_difference && purchase.scheme_difference != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Scheme Difference`,
                LedgerAmount:
                  -1 * parseFloat(purchase.scheme_difference).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.cost_difference && purchase.cost_difference != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Cost Difference`,
                LedgerAmount:
                  -1 * parseFloat(purchase.cost_difference).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.due && purchase.due != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Due`,
                LedgerAmount: -1 * parseFloat(purchase.due).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.freight_charges && purchase.freight_charges != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Freight Charges`,
                LedgerAmount: parseFloat(purchase.freight_charges).toFixed(2),
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
                LedgerAmount:
                  -1 * parseFloat(purchase.supplier_credit_note).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.mmh_manual_disc && purchase.mmh_manual_disc != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Discount on Purchase`,
                LedgerAmount:
                  -1 * parseFloat(purchase.mmh_manual_disc).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          if (purchase.round_off && purchase.round_off != 0) {
            purchaseEntry.ledgerentries.push(
              GET_LEDGER({
                LedgerName: `Round Off`,
                LedgerAmount: parseFloat(purchase.round_off).toFixed(2),
                IsDeemedPositive: "Yes",
              })
            );
          }

          let journalEntry = null;

          if (purchase.jv_ledger == 1) {
            journalEntry = INIT_JOURNAL_ENTRY(
              moment(purchase.mmh_mrc_dt).format("YYYYMMDD")
            );

            journalEntry.MasterID = `${purchase.purchase_id}-journal-entry`;
            journalEntry.VoucherNumber = purchase.mmh_mrc_refno;
            journalEntry.Reference = purchase.mmh_dist_bill_no;
            journalEntry.BuyerGSTRegistrationType = purchase.supplier_gstn
              ? "Regular"
              : "";
            journalEntry.PartyName = purchase.supplier_name;
            journalEntry.BuyerGSTIN = purchase.supplier_gstn;
            journalEntry.Voucher_Total = parseFloat(
              purchase.total_amount
            ).toFixed(2);
            journalEntry.Narration = purchase.narration;

            journalEntry.ledgerentries.push(
              GET_JOURNAL_LEDGER({
                LedgerName: purchase.supplier_name,
                LedgerAmount: parseFloat(purchase.total_amount).toFixed(2),
                IsDeemedPositive: "Yes",
                LedgerGroup: "$$GroupSundryCreditors",
                BillsAllocation: [
                  {
                    AgstType: "New Ref",
                    Reference: purchase.mmh_dist_bill_no,
                    Amount: -1 * parseFloat(purchase.total_amount),
                  },
                ],
                CategoryAllocation: [
                  {
                    Category: "Primary Cost Category",
                    isDeeemedPositive: "Yes",
                    CostCentreAllocation: [
                      {
                        Name: purchase.outlet_name,
                        Amount: parseFloat(purchase.total_amount).toFixed(2),
                      },
                    ],
                  },
                ],
              })
            );

            journalEntry.ledgerentries.push(
              GET_JOURNAL_LEDGER({
                LedgerName: "Ready To Pay",
                LedgerAmount: parseFloat(purchase.total_amount).toFixed(2),
                GroupName: "Bank Accounts",
                IsDeemedPositive: "No",
                IsPartyLedger: "Yes",
                CategoryAllocation: [
                  {
                    Category: "Primary Cost Category",
                    isDeeemedPositive: "Yes",
                    CostCentreAllocation: [
                      {
                        Name: purchase.outlet_name,
                        Amount: parseFloat(purchase.total_amount).toFixed(2),
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

  getLedgerObject(
    ledgerName,
    ledgerAmount,
    storeName,
    isCredit,
    ledgerGroup = "$$GroupCurrentAssets"
  ) {
    return {
      LedgerName: ledgerName,
      LedgerGroup: ledgerGroup,
      IsPartyLedger: null,
      LedgerAmount: ledgerAmount,
      IsDeemedPositive: isCredit ? "No" : "Yes",
      BillsAllocation: [],
      LedgerDescription: [],
      GSTClassification: " ",
      IGSTRate: null,
      AppropriateOnValue: "Yes",
      CategoryAllocation: [
        {
          Category: "Primary Cost Category",
          IsDeemedPositive: isCredit ? "No" : "Yes",
          CostCentreAllocation: [
            {
              Name: storeName,
              Amount: ledgerAmount,
            },
          ],
        },
      ],
    };
  }

  getCashSales(accountData) {
    const { total_sales, card_sales, loyalty } = accountData;
    const totalSales = parseFloat(total_sales);
    const cardSales = parseFloat(card_sales);
    const parsedLoyalty = parseFloat(loyalty);

    return totalSales - cardSales - parsedLoyalty;
  }

  async getTallySalesEntry(from_date, to_date) {
    try {
      const data = {};
      const filter = {
        from_date: new Date(from_date),
        to_date: new Date(to_date),
      };
      filter.from_date.setHours(0, 0, 0, 0);
      filter.to_date.setHours(23, 59, 59, 999);

      const accounts = await this.accountsUsecase.getAllAccounts(filter);
      const sales = accounts.data.account;

      sales.forEach((item) => {
        const date = moment(new Date(item.date)).format("YYYYMMDD");

        if (!data[item.outlet_name]) {
          data[item.outlet_name] = {};
        }

        if (!data[item.outlet_name][date]) {
          data[item.outlet_name][date] = {
            ...INIT_JOURNAL_ENTRY_OLD(date),
            MasterID: `${item.accounts_id}-sales-entry`,
          };
        }

        const cash_sales = this.getCashSales(item);
        const accountName = `Cash (${
          OUTLET_CASH_ID_MAP[item.store_id] ?? "N/A"
        })`;

        const cashSales =
          parseInt(cash_sales) +
          parseInt(item.loyalty) -
          parseInt(item.sales_return);

        const checkAndInsert = (
          ledgerName,
          ledgerAmount,
          storeName,
          isCredit,
          index,
          ledgerGroup
        ) => {
          if (!data[item.outlet_name][date].ledgerentries[index]) {
            data[item.outlet_name][date].ledgerentries[index] =
              this.getLedgerObject(
                ledgerName,
                parseInt(ledgerAmount),
                storeName,
                isCredit,
                ledgerGroup
              );
          } else {
            data[item.outlet_name][date].ledgerentries[index].LedgerAmount +=
              parseInt(ledgerAmount);

            data[item.outlet_name][date].ledgerentries[
              index
            ].CategoryAllocation[0].CostCentreAllocation[0].Amount +=
              parseInt(ledgerAmount);
          }
        };

        checkAndInsert(accountName, cashSales, item.outlet_name, false, 0);
        checkAndInsert(
          "Card Sales",
          item.card_sales,
          item.outlet_name,
          false,
          1
        );
        checkAndInsert(
          "sales",
          parseInt(item.card_sales) +
            (cash_sales + parseInt(item.loyalty) - parseInt(item.sales_return)),
          item.outlet_name,
          true,
          2,
          "$$GroupSales"
        );
      });

      const finalData = this.getFinalData(data);

      return {
        error: "false",
        data: finalData,
      };
    } catch (error) {
      console.log(error);
      return {
        error: error.toString(),
        data: [],
      };
    }
  }

  getFinalData(data) {
    return Object.keys(data).flatMap((storeNameKey) =>
      Object.keys(data[storeNameKey]).map(
        (dateKey) => data[storeNameKey][dateKey]
      )
    );
  }

  async getTallyCardToBank(from_date, to_date) {
    try {
      const data = {};

      const filter = {
        from_date: new Date(from_date),
        to_date: new Date(to_date),
      };
      filter.from_date.setHours(0, 0, 0, 0);
      filter.to_date.setHours(23, 59, 59, 999);

      const accounts = await this.accountsUsecase.getAllAccounts(filter);
      const ebook = accounts.data.ebook;
      let totalCardSales = {};

      ebook.forEach((item) => {
        const date = moment(new Date(item.date)).format("YYYYMMDD");

        if (!data[item.store_name]) {
          data[item.store_name] = {};
        }

        if (!data[item.store_name][date]) {
          data[item.store_name][date] = {
            ...INIT_JOURNAL_ENTRY_OLD(date),
            MasterID: `${item.ebook_id}-ebook`,
          };
        }

        if (!totalCardSales[item.store_name]) {
          totalCardSales[item.store_name] = {};
        }

        if (!totalCardSales[item.store_name][date]) {
          totalCardSales[item.store_name][date] = 0;
        }

        if (item.hdur) {
          totalCardSales[item.store_name][date] += item.hdur;
          data[item.store_name][date].ledgerentries.push(
            this.getLedgerObject(
              "HDFC - UPI",
              item.hdur,
              item.store_name,
              false
            )
          );
        }

        if (item.hfpp) {
          totalCardSales[item.store_name][date] += item.hfpp;
          data[item.store_name][date].ledgerentries.push(
            this.getLedgerObject(
              "HDFC (Card)",
              item.hfpp,
              item.store_name,
              false
            )
          );
        }

        if (item.sedc) {
          totalCardSales[item.store_name][date] += item.sedc;
          data[item.store_name][date].ledgerentries.push(
            this.getLedgerObject("Sodexo", item.sedc, item.store_name, false)
          );
        }

        if (item.ppbl) {
          totalCardSales[item.store_name][date] += item.ppbl;
          data[item.store_name][date].ledgerentries.push(
            this.getLedgerObject("Paytm", item.ppbl, item.store_name, false)
          );
        }
      });

      Object.keys(totalCardSales).forEach((storeNameKey) => {
        Object.keys(totalCardSales[storeNameKey]).forEach((dateKey) => {
          const cardSales = totalCardSales[storeNameKey][dateKey];

          data[storeNameKey][dateKey].ledgerentries.push(
            this.getLedgerObject("Card Sales", cardSales, storeNameKey, true)
          );
        });
      });

      const finalData = this.getFinalData(data);

      return {
        error: "false",
        data: finalData,
      };
    } catch (error) {
      console.log(error);
      return {
        error: error.toString(),
        data: [],
      };
    }
  }

  getAmmountDifference(values, totalCashHandover) {
    try {
      const {
        total_sales,
        card_sales,
        loyalty,
        sales_return,
        accounts,
        sales,
      } = values;

      let calculated_sales =
        totalCashHandover +
        (card_sales ? parseFloat(card_sales) : 0) +
        (loyalty ? parseFloat(loyalty) : 0) +
        (sales_return ? parseFloat(sales_return) : 0);

      if (accounts || sales) {
        (accounts ?? sales).forEach((item) => {
          if (item.payment_type == 1) {
            // Payment
            calculated_sales += item.amount ? parseFloat(item.amount) : 0;
          } else {
            // Receipt
            calculated_sales -= item.amount ? parseFloat(item.amount) : 0;
          }
        });
      }

      return parseInt(total_sales) - calculated_sales;
    } catch (err) {
      console.log(err);
      return 0;
    }
  }

  getTotalCashHandover(accountItem) {
    return (
      accountItem.cash_handover_500 * 500 +
      accountItem.cash_handover_200 * 200 +
      accountItem.cash_handover_100 * 100 +
      accountItem.cash_handover_50 * 50 +
      accountItem.cash_handover_20 * 20 +
      accountItem.cash_handover_10 * 10 +
      accountItem.cash_handover_5 * 5 +
      accountItem.cash_handover_2 * 2 +
      accountItem.cash_handover_1 * 1
    );
  }

  async getTallyExpenses(from_date, to_date) {
    try {
      const data = {};
      const filter = {
        from_date: new Date(from_date),
        to_date: new Date(to_date),
      };
      filter.from_date.setHours(0, 0, 0, 0);
      filter.to_date.setHours(23, 59, 59, 999);
      const accounts = await this.accountsUsecase.getAllAccounts(filter);

      const totals = {};

      const expenses = accounts.data.account.flatMap((accountItem) => {
        const date = moment(new Date(accountItem.date)).format("YYYYMMDD");

        if (!totals[accountItem.outlet_name]) {
          totals[accountItem.outlet_name] = {};
        }

        if (!totals[accountItem.outlet_name][date]) {
          totals[accountItem.outlet_name][date] = {
            loyalty: 0,
            cash: 0,
            difference: 0,
            difference_excess_list: [],
          };
        }

        totals[accountItem.outlet_name][date].loyalty += parseInt(
          accountItem.loyalty
        );

        const totalCash = this.getTotalCashHandover(accountItem);

        totals[accountItem.outlet_name][date].cash += totalCash;

        const currentDifference = this.getAmmountDifference(
          accountItem,
          totalCash
        );

        if (currentDifference < 0) {
          totals[accountItem.outlet_name][date].difference +=
            Math.abs(currentDifference);
        } else if (currentDifference > 0) {
          totals[accountItem.outlet_name][date].difference_excess_list.push({
            ...this.getLedgerObject(
              accountItem.cashier_name,
              currentDifference,
              accountItem.outlet_name,
              false
            ),
            itemId: `${accountItem.accounts_id}-accounts-${accountItem.outlet_name}`,
          });
        }

        if (!accountItem.sales) {
          return [
            {
              outlet_name: accountItem.outlet_name,
              store_id: accountItem.store_id,
              date: accountItem.date,
            },
          ];
        }

        return accountItem.sales.map((item) => ({
          ...item,
          outlet_name: accountItem.outlet_name,
          store_id: accountItem.store_id,
          date: accountItem.date,
        }));
      });

      const warehouseExpensesRes = await this.accountsUsecase.getWarehouseSales(
        filter
      );
      const warehouseExpenses = warehouseExpensesRes.data;

      const parseList = (list, defaultOutletName) => {
        list.forEach((item) => {
          if (defaultOutletName) {
            item.outlet_name = defaultOutletName;
          }

          const uniqueId = `${item.sales_id}-sales-${item.outlet_name}`;
          const date = moment(new Date(item.date)).format("YYYYMMDD");

          if (!data[item.outlet_name]) {
            data[item.outlet_name] = {};
          }

          if (!data[item.outlet_name][date]) {
            data[item.outlet_name][date] = INIT_JOURNAL_ENTRY_OLD(date);
            data[item.outlet_name][date].store_id = item.store_id;

            if (totals[item.outlet_name] && totals[item.outlet_name][date]) {
              if (totals[item.outlet_name][date].loyalty) {
                data[item.outlet_name][date].ledgerentries.push({
                  ...this.getLedgerObject(
                    "Loyalty",
                    totals[item.outlet_name][date].loyalty,
                    item.outlet_name,
                    false
                  ),
                  Narration: "",
                  itemId: `${uniqueId}-loyalty`,
                });
              }

              if (totals[item.outlet_name][date].cash) {
                data[item.outlet_name][date].ledgerentries.push({
                  ...this.getLedgerObject(
                    "Cash",
                    totals[item.outlet_name][date].cash,
                    item.outlet_name,
                    false
                  ),
                  Narration: "Handover",
                  itemId: `${uniqueId}-cash-handover`,
                });
              }

              if (totals[item.outlet_name][date].difference_excess_list) {
                data[item.outlet_name][date].ledgerentries = [
                  ...data[item.outlet_name][date].ledgerentries,
                  ...totals[item.outlet_name][date].difference_excess_list,
                ];
              }

              if (
                totals[item.outlet_name][date].difference &&
                totals[item.outlet_name][date].difference > 0
              ) {
                data[item.outlet_name][date].ledgerentries.push({
                  ...this.getLedgerObject(
                    "Cash Excess",
                    totals[item.outlet_name][date].difference,
                    item.outlet_name,
                    true
                  ),
                  Narration: "",
                  itemId: `${uniqueId}-cash-excess`,
                });
              }
            }
          }

          if (item.person_name) {
            data[item.outlet_name][date].ledgerentries.push({
              ...this.getLedgerObject(
                item.person_name,
                item.amount,
                item.outlet_name,
                item.payment_type === 2
              ),
              Narration: item.description,
              itemId: uniqueId,
            });
          }
        });
      };

      parseList(expenses, undefined);
      parseList(warehouseExpenses, "Warehouse");

      const finalData = [];

      Object.keys(data).map((outlet_name) => {
        Object.keys(data[outlet_name]).map((date) => {
          const tmpMasterData = data[outlet_name][date];
          const tmpLedgerEntries = tmpMasterData.ledgerentries;
          tmpMasterData.ledgerentries = [];

          const accountName = OUTLET_CASH_ID_MAP[tmpMasterData.store_id]
            ? `Cash (${OUTLET_CASH_ID_MAP[tmpMasterData.store_id]})`
            : "Cash";

          finalData.push(
            ...tmpLedgerEntries.map((item) => {
              const tmpObject = {
                ...tmpMasterData,
                MasterID: item.itemId,
                Narration: item.Narration ?? "",
                VoucherType:
                  item.IsDeemedPositive === "No" ? "Receipt" : "Payment",
                VoucherBaseType:
                  item.IsDeemedPositive === "No" ? "Receipt" : "Payment",
                ledgerentries: [
                  this.getLedgerObject(
                    item.LedgerName,
                    item.LedgerAmount,
                    item.CategoryAllocation[0].CostCentreAllocation[0].Name,
                    item.IsDeemedPositive === "No",
                    "$$GroupIndirectExpenses"
                  ),

                  this.getLedgerObject(
                    accountName,
                    item.LedgerAmount,
                    item.CategoryAllocation[0].CostCentreAllocation[0].Name,
                    item.IsDeemedPositive === "Yes",
                    "$$GroupCurrentAssets"
                  ),
                ],
              };

              delete tmpObject.store_id;

              return tmpObject;
            })
          );
        });
      });

      // const finalData = this.getFinalData(data);

      return { error: "false", data: finalData };
    } catch (error) {
      console.log(error);
      return {
        error: error.toString(),
        data: [],
      };
    }
  }
}

module.exports = (
  tallyRepo,
  purchaseUsecase,
  accountsUsecase,
  debitNoteUsecase
) => {
  return new TallyUsecase(
    tallyRepo,
    purchaseUsecase,
    accountsUsecase,
    debitNoteUsecase
  );
};
