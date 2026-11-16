import Supplier from '../models/Supplier.js';
import Purchase from '../models/Purchase.js';
import SupplierPayment from '../models/SupplierPayment.js';
import PurchaseReturn from '../models/PurchaseReturn.js';
import SupplierCreditReceipt from '../models/SupplierCreditReceipt.js';
import CustomerDebtTransfer from '../models/CustomerDebtTransfer.js';
import { createPersonService } from './personService.js';

export const supplierService = createPersonService({
  Model: Supplier,
  TransactionModel: Purchase,
  refField: 'supplierId',
  activityType: 'supplier',
  entityType: 'Supplier',
  // Standalone settlements WE pay to the supplier (see SupplierPayment.js /
  // supplierPayment.service.js) that reduce our running balance without
  // touching any Purchase.
  PaymentModel: SupplierPayment,
  // Standalone returns of goods back to the supplier (see PurchaseReturn.js
  // / purchaseReturn.service.js) that reduce our running balance without
  // touching any Purchase.
  ReturnModel: PurchaseReturn,
  // Money WE receive back from the supplier against a creditOwed balance
  // (see SupplierCreditReceipt.js / supplierCreditReceipt.service.js) —
  // brings creditOwed back down once the supplier actually settles it.
  PayoutModel: SupplierCreditReceipt,
  // Debt moved to/from this supplier (see customerDebtTransfer.service.js).
  // The supplier's raw figure is "we owe them", so the sign is -1 (debt moved
  // onto a supplier lowers it). Also blocks deleting a supplier who appears in
  // any transfer, so the record is never orphaned.
  TransferModel: CustomerDebtTransfer,
  transferFromField: 'fromSupplierId',
  transferToField: 'toSupplierId',
  transferSign: -1,
  // See personService.js's createPersonService doc block for why this is
  // the OPPOSITE value from Customer's — this was the confirmed bug.
  openingBalancePositiveDirection: 'we_owe_them',
  labels: {
    notFound: 'المورد غير موجود',
    deleteBlocked: 'لا يمكن حذف مورد له عمليات شراء مسجلة',
    added: 'تمت إضافة مورد جديد',
    updated: 'تم تعديل بيانات المورد',
    deleted: 'تم حذف المورد',
  },
});

export default supplierService;