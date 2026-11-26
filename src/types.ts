export type ModuleKey =
  | 'dashboard'
  | 'customers'
  | 'measurements'
  | 'orders'
  | 'estimation'
  | 'inventory'
  | 'pos'
  | 'reports'
  | 'settings';

export interface AuthUser {
  userId: number;
  businessId: number;
  fullName: string;
  username: string;
  email: string;
  phone: string;
  businessName: string;
  businessAddress: string;
  receiptFooter: string;
  currency: string;
  csrfToken: string;
  sessionToken?: string;
}

export interface Customer {
  id: number;
  client_uuid?: string | null;
  customer_number: string;
  full_name: string;
  phone: string;
  email: string;
  address: string;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface Measurement {
  id: number;
  client_uuid?: string | null;
  customer_id: number;
  customer_name?: string;
  customer_number?: string;
  garment_type: string;
  unit: 'cm' | 'in';
  values_json: string;
  notes: string;
  version: number;
  recorded_at: string;
  updated_at: string;
}

export interface MeasurementHistoryItem {
  id: number;
  measurement_id: number;
  customer_id: number;
  garment_type: string;
  unit: string;
  values_json: string;
  notes: string;
  version: number;
  recorded_at: string;
}

export type OrderStatus =
  | 'Pending'
  | 'In Progress'
  | 'Completed'
  | 'Ready for Collection'
  | 'Collected'
  | 'Cancelled';

export interface TailoringOrder {
  id: number;
  client_uuid?: string | null;
  order_number: string;
  customer_id: number;
  customer_name?: string;
  customer_number?: string;
  customer_phone?: string;
  customer_email?: string;
  measurement_id: number | null;
  garment_type: string;
  design_specs: string;
  color: string;
  quantity: number;
  order_date: string;
  expected_completion_date: string;
  agreed_price: number;
  labour_cost: number;
  other_expenses: number;
  total_paid?: number;
  status: OrderStatus;
  notes: string;
  created_at: string;
  updated_at: string;
}

export interface EstimationRule {
  id: number;
  garment_type: string;
  design_style: string;
  base_fabric_meters: number;
  fabric_width_cm: number;
  allowance_percent: number;
  lining_ratio: number;
  interfacing_meters: number;
  thread_spools: number;
  buttons_count: number;
  zippers_count: number;
  notes: string;
  updated_at: string;
}

export interface EstimationItem {
  materialId: number | null;
  materialName: string;
  category: string;
  estimatedQty: number;
  unit: string;
  availableQty: number;
  shortageQty: number;
  estimatedUnitCost: number;
  estimatedTotalCost: number;
}

export interface FabricEstimation {
  id: number;
  order_id: number;
  order_number?: string;
  garment_type?: string;
  customer_name?: string;
  rule_id: number | null;
  fabric_width_cm: number;
  allowance_percent: number;
  items_json: string;
  total_estimated_cost: number;
  notes: string;
  created_at: string;
}

export interface Material {
  id: number;
  sku: string;
  name: string;
  category: string;
  description: string;
  unit: string;
  purchase_price: number;
  current_qty: number;
  reserved_qty: number;
  min_stock_level: number;
  created_at: string;
  updated_at: string;
}

export interface MaterialUsageRecord {
  id: number;
  order_id: number;
  order_number?: string;
  material_id: number;
  material_name?: string;
  material_unit?: string;
  issued_qty: number;
  consumed_qty: number;
  returned_qty: number;
  wasted_qty: number;
  unit_cost_at_time: number;
  actual_cost: number;
  status: 'Issued' | 'Partial' | 'Settled';
  notes: string;
  recorded_at: string;
  updated_at: string;
}

export interface InventoryTransaction {
  id: number;
  material_id: number;
  material_name?: string;
  material_unit?: string;
  order_id: number | null;
  order_number?: string;
  tx_type: 'PURCHASE' | 'ISSUE' | 'CONSUME' | 'RETURN' | 'WASTE' | 'ADJUSTMENT';
  qty: number;
  unit_cost: number;
  total_cost: number;
  notes: string;
  created_at: string;
}

export interface Payment {
  id: number;
  client_uuid?: string | null;
  receipt_number: string;
  order_id: number;
  order_number?: string;
  agreed_price?: number;
  customer_id: number;
  customer_name?: string;
  customer_number?: string;
  amount: number;
  payment_method: 'Cash' | 'M-Pesa' | 'Bank';
  payment_type: 'Deposit' | 'Partial' | 'Final';
  status: 'Completed' | 'Pending' | 'Failed';
  mpesa_receipt_number?: string;
  notes: string;
  paid_at: string;
  created_at: string;
}

export interface BusinessExpense {
  id: number;
  order_id: number | null;
  order_number?: string | null;
  category: string;
  description: string;
  amount: number;
  expense_date: string;
  created_at: string;
}

export interface WorkspaceData {
  syncedAt: string;
  customers: Customer[];
  measurements: Measurement[];
  measurementHistory: MeasurementHistoryItem[];
  orders: TailoringOrder[];
  estimationRules: EstimationRule[];
  estimations: FabricEstimation[];
  materials: Material[];
  usageRecords: MaterialUsageRecord[];
  inventoryTransactions: InventoryTransaction[];
  payments: Payment[];
  expenses: BusinessExpense[];
}

export interface BackupSummary {
  schemaVersion: number;
  fileSizeBytes: number;
  businesses: number;
  customers: number;
  orders: number;
  payments: number;
  materials: number;
}

export interface BackupStatus {
  dbPath: string;
  schemaVersion: number;
  fileSizeBytes: number;
  suggestedFilename: string;
  lastBackupAt: string;
  lastBackupPath: string;
  reminderDays: number;
  reminderDue: boolean;
  counts: {
    customers: number;
    orders: number;
    payments: number;
    materials: number;
  };
}

export interface BackupValidationResult {
  valid: boolean;
  error?: string;
  summary?: BackupSummary;
}
