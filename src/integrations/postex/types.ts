/**
 * Field names below are the ones the live PostEx API returned during the September 2026
 * verification, not the ones in the v4.1.9 PDF guide (the guide disagrees in several places).
 */
export interface PostexParcel {
  trackingNumber: string;
  /** The Shopify order name, e.g. "#63648", on ~95% of parcels. */
  orderRefNumber: string;
  transactionStatus: string;
  transactionDate: string;
  orderPickupDate?: string;
  orderDeliveryDate?: string;
  /** COD value to collect. Zero on PR/gift parcels. */
  invoicePayment: number;
  /** Forward charge; present on delivered parcels only. */
  transactionFee: number;
  transactionTax: number;
  /** Return charge; present on returned parcels only. reversalTax is 16% of reversalFee. */
  reversalFee: number;
  reversalTax: number;
  cityName: string;
  items: number;
  invoiceDivision: number;
  orderDetail?: string;
  merchantName?: string;
  bookingWeight?: number;
  actualWeight?: number;
  upfrontPayment?: number;
  reservePayment?: number;
  balancePayment?: number;
  statusUpdatedAt?: string;
  transactionStatusHistory?: PostexStatusStep[];
  /** Customer PII. Only ever read when a feature genuinely needs it. */
  customerName?: string;
  customerPhone?: string;
  deliveryAddress?: string;
}

export interface PostexStatusStep {
  /** e.g. "Attempt Made: RFD(REFUSED TO RECEIVE)" */
  transactionStatusMessage: string;
  /** e.g. "0005" delivered, "0013" failed attempt, "0006" returned to merchant. */
  transactionStatusMessageCode: string;
  updatedAt: string;
}

export interface PostexPaymentStatus {
  orderRefNumber: string;
  trackingNumber: string;
  settle: boolean;
  settlementDate?: string;
  cpr1?: string;
  cpr1Date?: string;
}

export interface PostexShipperAdvice {
  trackingNumber?: string;
  orderRefNumber?: string;
  remarks?: string;
  remarksDate?: string;
  username?: string;
  invoicePayment?: number;
}

/** Status ids accepted by get-all-order. 0 lists everything. */
export const POSTEX_STATUS_IDS = {
  all: 0,
  unbooked: 1,
  booked: 2,
  postexWarehouse: 3,
  outForDelivery: 4,
  delivered: 5,
  returned: 6,
  unassignedByMe: 7,
  expired: 8,
  deliveryUnderReview: 9,
  pickedByPostex: 15,
  outForReturn: 16,
  attempted: 17,
  enRouteToWarehouse: 18,
} as const;

export type PostexStatusId = (typeof POSTEX_STATUS_IDS)[keyof typeof POSTEX_STATUS_IDS];
