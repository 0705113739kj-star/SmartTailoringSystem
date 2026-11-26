import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createExpressApp } from '../src/server/app.ts';
import { hashPassword, hashToken, verifyPassword } from '../src/server/auth.ts';
import { createDatabase, type DbHolder } from '../src/server/db.ts';
import { buildPdfBlob } from '../src/lib/print.ts';
import { createMobileBackend } from '../src/mobile/inAppBackend.ts';
import { createInMemoryPersistenceAdapter } from '../src/mobile/sqlJsDb.ts';
import { hashPasswordPortable, hashTokenPortable, verifyPasswordPortable } from '../src/shared/crypto.ts';

async function startTestServer(dbPath = 'sqlite::memory:') {
  const db = await createDatabase(dbPath);
  const holder: DbHolder = { current: db };
  const app = createExpressApp(holder);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${addr.port}`;
  return { holder, server, baseUrl };
}

class CookieClient {
  private baseUrl: string;
  private cookies: Record<string, string> = {};
  public csrfToken = '';

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  async request<T = Record<string, unknown>>(
    reqPath: string,
    options: { method?: string; body?: unknown; skipCsrf?: boolean } = {}
  ): Promise<{ status: number; data: T }> {
    const method = options.method || 'GET';
    const headers: Record<string, string> = {};
    const cookieHeader = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    if (!options.skipCsrf && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && this.csrfToken) {
      headers['X-CSRF-Token'] = this.csrfToken;
    }

    const res = await fetch(`${this.baseUrl}${reqPath}`, {
      method,
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });

    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) {
        const name = pair.slice(0, eq).trim();
        const val = pair.slice(eq + 1).trim();
        this.cookies[name] = val;
        if (name === 'tailorpos_csrf') this.csrfToken = decodeURIComponent(val);
      }
    }

    const data = (await res.json()) as T;
    return { status: res.status, data };
  }

  async downloadBytes(reqPath: string): Promise<{ status: number; bytes: Uint8Array }> {
    const headers: Record<string, string> = {};
    const cookieHeader = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookieHeader) headers['Cookie'] = cookieHeader;

    const res = await fetch(`${this.baseUrl}${reqPath}`, { method: 'GET', headers });
    const buf = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, bytes: buf };
  }

  async uploadBytes<T = Record<string, unknown>>(
    reqPath: string,
    bytes: Uint8Array
  ): Promise<{ status: number; data: T }> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };
    const cookieHeader = Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
    if (cookieHeader) headers['Cookie'] = cookieHeader;
    if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;

    const res = await fetch(`${this.baseUrl}${reqPath}`, {
      method: 'POST',
      headers,
      body: Buffer.from(bytes),
    });
    const data = (await res.json()) as T;
    return { status: res.status, data };
  }
}

test('SQLite schema initialization records version 2 and schema_migrations history', async () => {
  const { holder, server } = await startTestServer();
  try {
    const version = await holder.current.getSchemaVersion();
    assert.equal(version, 2);

    const migrations = await holder.current.query<{ version: number; name: string }>(
      `SELECT version, name FROM schema_migrations ORDER BY version ASC`
    );
    assert.equal(migrations.length, 2);
    assert.equal(migrations[0].version, 1);
    assert.equal(migrations[1].version, 2);
  } finally {
    server.close();
    await holder.current.close();
  }
});

test('Registration, CSRF protection, and strict multi-tenant business isolation', async () => {
  const { holder, server, baseUrl } = await startTestServer();
  try {
    const bizA = new CookieClient(baseUrl);
    const bizB = new CookieClient(baseUrl);

    const regA = await bizA.request<{ user: { businessId: number } }>('/api/auth/register', {
      method: 'POST',
      body: {
        businessName: 'Atelier Alpha',
        ownerName: 'Alice',
        email: 'alice@alpha.test',
        phone: '0700111222',
        password: 'password123',
        confirmPassword: 'password123',
      },
    });
    assert.equal(regA.status, 201);

    const regB = await bizB.request<{ user: { businessId: number } }>('/api/auth/register', {
      method: 'POST',
      body: {
        businessName: 'Atelier Beta',
        ownerName: 'Bob',
        email: 'bob@beta.test',
        phone: '0700333444',
        password: 'password123',
        confirmPassword: 'password123',
      },
    });
    assert.equal(regB.status, 201);
    assert.notEqual(regA.data.user.businessId, regB.data.user.businessId);

    // CSRF rejection check
    const noCsrf = await bizA.request('/api/customers', {
      method: 'POST',
      skipCsrf: true,
      body: { fullName: 'CSRF Test', phone: '0711000111' },
    });
    assert.equal(noCsrf.status, 403);

    // Biz A creates a customer
    const custA = await bizA.request<{ customer: { id: number } }>('/api/customers', {
      method: 'POST',
      body: { fullName: 'John Doe', phone: '0711000111' },
    });
    assert.equal(custA.status, 201);

    // Biz B MUST NOT see or access Biz A's customer
    const bizBList = await bizB.request<{ customers: Array<{ id: number }> }>('/api/customers');
    assert.equal(bizBList.data.customers.length, 0);

    const crossRead = await bizB.request(`/api/customers/${custA.data.customer.id}`);
    assert.equal(crossRead.status, 404);

    // Biz B MUST NOT create an order referencing Biz A's customer
    const crossOrder = await bizB.request('/api/orders', {
      method: 'POST',
      body: {
        customerId: custA.data.customer.id,
        garmentType: 'Suit',
        agreedPrice: 15000,
      },
    });
    assert.equal(crossOrder.status, 404);
  } finally {
    server.close();
    await holder.current.close();
  }
});

test('Inventory consumption, zero double-counting on returns, and installment balance accuracy', async () => {
  const { holder, server, baseUrl } = await startTestServer();
  try {
    const client = new CookieClient(baseUrl);
    await client.request('/api/auth/register', {
      method: 'POST',
      body: {
        businessName: 'Savile Test',
        ownerName: 'Grace',
        email: 'grace@savile.test',
        phone: '0722111222',
        password: 'password123',
        confirmPassword: 'password123',
      },
    });

    const cust = await client.request<{ customer: { id: number } }>('/api/customers', {
      method: 'POST',
      body: { fullName: 'Peter Kamau', phone: '0722999888' },
    });

    const mat = await client.request<{ material: { id: number; current_qty: number } }>('/api/materials', {
      method: 'POST',
      body: {
        name: 'Navy Merino Wool',
        category: 'Suit Fabric',
        unit: 'meters',
        purchasePrice: 2000,
        currentQty: 20,
        minStockLevel: 4,
      },
    });

    const order = await client.request<{ order: { id: number } }>('/api/orders', {
      method: 'POST',
      body: {
        customerId: cust.data.customer.id,
        garmentType: 'Suit',
        agreedPrice: 18000,
        depositAmount: 6000,
      },
    });
    assert.equal(order.status, 201);

    // Issue 4m to workshop -> current_qty becomes 16, reserved_qty becomes 4
    const issue = await client.request<{ usageRecord: { id: number } }>('/api/material-usage', {
      method: 'POST',
      body: {
        orderId: order.data.order.id,
        materialId: mat.data.material.id,
        issuedQty: 4,
      },
    });
    assert.equal(issue.status, 201);

    // Settle: 3.1m consumed, 0.7m returned, 0.2m wasted -> total 4.0m
    // current_qty should become 16 + 0.7 = 16.7 (no double deduction!), actual_cost = (3.1 + 0.2) * 2000 = 6600
    const settle = await client.request<{ usageRecord: { actual_cost: number; status: string } }>(
      `/api/material-usage/${issue.data.usageRecord.id}/settle`,
      {
        method: 'POST',
        body: { consumedQty: 3.1, returnedQty: 0.7, wastedQty: 0.2 },
      }
    );
    assert.equal(settle.status, 200);
    assert.equal(settle.data.usageRecord.status, 'Settled');
    assert.equal(settle.data.usageRecord.actual_cost, 6600);

    const matsAfter = await client.request<{ materials: Array<{ current_qty: number; reserved_qty: number }> }>(
      '/api/materials'
    );
    assert.equal(matsAfter.data.materials[0].current_qty, 16.7);
    assert.equal(matsAfter.data.materials[0].reserved_qty, 0);

    // Record partial Cash payment 4000 -> total paid = 6000 + 4000 = 10000, balance = 8000
    const pay2 = await client.request('/api/payments', {
      method: 'POST',
      body: { orderId: order.data.order.id, amount: 4000, paymentMethod: 'Cash', paymentType: 'Partial' },
    });
    assert.equal(pay2.status, 201);

    // Record Manual M-Pesa payment with optional transaction reference & custom paidAt -> total paid = 13000, balance = 5000
    const mpesaPay = await client.request<{
      payment: { payment_method: string; mpesa_receipt_number: string; status: string; notes: string };
    }>('/api/payments', {
      method: 'POST',
      body: {
        orderId: order.data.order.id,
        amount: 3000,
        paymentMethod: 'M-Pesa',
        paymentType: 'Partial',
        mpesaReference: 'ub12xyz890',
        paidAt: '2026-10-15T14:30:00.000Z',
        notes: 'Received on Till 551122',
      },
    });
    assert.equal(mpesaPay.status, 201);
    assert.equal(mpesaPay.data.payment.payment_method, 'M-Pesa');
    assert.equal(mpesaPay.data.payment.mpesa_receipt_number, 'UB12XYZ890');
    assert.equal(mpesaPay.data.payment.status, 'Completed');
    assert.equal(mpesaPay.data.payment.notes, 'Received on Till 551122');

    // Record Manual M-Pesa without optional transaction reference & Bank transfer for remaining 5000
    const mpesaNoRef = await client.request('/api/payments', {
      method: 'POST',
      body: { orderId: order.data.order.id, amount: 2000, paymentMethod: 'M-Pesa', paymentType: 'Partial' },
    });
    assert.equal(mpesaNoRef.status, 201);

    const bankFinal = await client.request<{
      payment: { payment_method: string; mpesa_receipt_number: string; payment_type: string };
    }>('/api/payments', {
      method: 'POST',
      body: {
        orderId: order.data.order.id,
        amount: 3000,
        paymentMethod: 'Bank',
        paymentType: 'Final',
        mpesaReference: 'FT261015009',
      },
    });
    assert.equal(bankFinal.status, 201);
    assert.equal(bankFinal.data.payment.payment_method, 'Bank');
    assert.equal(bankFinal.data.payment.mpesa_receipt_number, 'FT261015009');

    const orderDetail = await client.request<{
      financials: { agreedPrice: number; totalPaid: number; outstandingBalance: number; actualMaterialCost: number };
    }>(`/api/orders/${order.data.order.id}`);
    assert.equal(orderDetail.data.financials.agreedPrice, 18000);
    assert.equal(orderDetail.data.financials.totalPaid, 18000);
    assert.equal(orderDetail.data.financials.outstandingBalance, 0);
    assert.equal(orderDetail.data.financials.actualMaterialCost, 6600);

    // Overpayment beyond balance is rejected cleanly
    const overPay = await client.request('/api/payments', {
      method: 'POST',
      body: { orderId: order.data.order.id, amount: 500, paymentMethod: 'M-Pesa', paymentType: 'Partial' },
    });
    assert.equal(overPay.status, 400);
  } finally {
    server.close();
    await holder.current.close();
  }
});

test('Local SQLite backup export, validation, preferences, and transactional restore with safety snapshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts-backup-test-'));
  const dbPath = path.join(tempDir, 'smarttailoring.db');
  const { holder, server, baseUrl } = await startTestServer(dbPath);
  try {
    const client = new CookieClient(baseUrl);
    await client.request('/api/auth/register', {
      method: 'POST',
      body: {
        businessName: 'Backup Bespoke',
        ownerName: 'Clara',
        email: 'clara@backup.test',
        phone: '0766111222',
        password: 'password123',
        confirmPassword: 'password123',
      },
    });

    // Create initial customer before taking snapshot
    const cust1 = await client.request<{ customer: { id: number } }>('/api/customers', {
      method: 'POST',
      body: { fullName: 'Customer Before Backup', phone: '0766000111' },
    });
    assert.equal(cust1.status, 201);

    // Update backup reminder preference
    const prefRes = await client.request<{ reminderDays: number }>('/api/backup/preferences', {
      method: 'PUT',
      body: { reminderDays: 14 },
    });
    assert.equal(prefRes.status, 200);
    assert.equal(prefRes.data.reminderDays, 14);

    // Export consistent SQLite snapshot
    const exported = await client.downloadBytes('/api/backup/export');
    assert.equal(exported.status, 200);
    const headerStr = Buffer.from(exported.bytes.slice(0, 16)).toString('utf8');
    assert.equal(headerStr, 'SQLite format 3\0');

    // Status reflects last backup and record count
    const statusRes = await client.request<{
      schemaVersion: number;
      reminderDays: number;
      lastBackupAt: string;
      counts: { customers: number };
    }>('/api/backup/status');
    assert.equal(statusRes.status, 200);
    assert.equal(statusRes.data.schemaVersion, 2);
    assert.equal(statusRes.data.reminderDays, 14);
    assert.ok(statusRes.data.lastBackupAt.length > 0);
    assert.equal(statusRes.data.counts.customers, 1);

    // Validate exported backup passes, corrupted payload fails
    const validRes = await client.uploadBytes<{ valid: boolean; summary?: { customers: number } }>(
      '/api/backup/validate',
      exported.bytes
    );
    assert.equal(validRes.status, 200);
    assert.equal(validRes.data.valid, true);
    assert.equal(validRes.data.summary?.customers, 1);

    const corruptRes = await client.uploadBytes<{ valid: boolean }>(
      '/api/backup/validate',
      new TextEncoder().encode('not-a-sqlite-file')
    );
    assert.equal(corruptRes.status, 400);
    assert.equal(corruptRes.data.valid, false);

    // Add a second customer AFTER the backup snapshot was taken
    const cust2 = await client.request('/api/customers', {
      method: 'POST',
      body: { fullName: 'Customer After Backup', phone: '0766000222' },
    });
    assert.equal(cust2.status, 201);

    const listBeforeRestore = await client.request<{ customers: Array<unknown> }>('/api/customers');
    assert.equal(listBeforeRestore.data.customers.length, 2);

    // Restore from the earlier snapshot -> creates safety snapshot & reverts customer list to 1
    const restoreRes = await client.uploadBytes<{ restored: boolean; safetyBackupPath: string }>(
      '/api/backup/restore',
      exported.bytes
    );
    assert.equal(restoreRes.status, 200);
    assert.equal(restoreRes.data.restored, true);
    assert.ok(fs.existsSync(restoreRes.data.safetyBackupPath), 'Pre-restore safety snapshot should exist on disk');

    const listAfterRestore = await client.request<{ customers: Array<{ full_name: string }> }>('/api/customers');
    assert.equal(listAfterRestore.status, 200);
    assert.equal(listAfterRestore.data.customers.length, 1);
    assert.equal(listAfterRestore.data.customers[0].full_name, 'Customer Before Backup');
  } finally {
    server.close();
    await holder.current.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('Bearer session auth without cookies registers customers and prevents duplicates', async () => {
  const { holder, server, baseUrl } = await startTestServer();
  try {
    const regRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        businessName: 'Iframe Tailor',
        ownerName: 'Jane',
        email: 'jane@iframe.test',
        phone: '0733000111',
        password: 'password123',
        confirmPassword: 'password123',
      }),
    });
    assert.equal(regRes.status, 201);
    const regJson = (await regRes.json()) as {
      user: { csrfToken: string; sessionToken?: string };
    };
    assert.ok(regJson.user.sessionToken, 'register should return sessionToken');
    assert.ok(regJson.user.csrfToken, 'register should return csrfToken');

    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${regJson.user.sessionToken}`,
      'X-CSRF-Token': regJson.user.csrfToken,
    };

    const custRes = await fetch(`${baseUrl}/api/customers`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        fullName: 'Samuel Ochieng',
        phone: '0733444555',
        email: 'samuel@client.test',
        clientUuid: 'uuid-cust-1',
      }),
    });
    assert.equal(custRes.status, 201);
    const custJson = (await custRes.json()) as {
      customer: { customer_number: string; full_name: string };
    };
    assert.equal(custJson.customer.customer_number, 'CUS-0001');
    assert.equal(custJson.customer.full_name, 'Samuel Ochieng');

    // Idempotent clientUuid returns existing customer cleanly
    const idempRes = await fetch(`${baseUrl}/api/customers`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        fullName: 'Samuel Ochieng',
        phone: '0733444555',
        clientUuid: 'uuid-cust-1',
      }),
    });
    assert.equal(idempRes.status, 200);

    // Duplicate phone with a new clientUuid is blocked with 409
    const dupRes = await fetch(`${baseUrl}/api/customers`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        fullName: 'Samuel Duplicate',
        phone: '0733444555',
        clientUuid: 'uuid-cust-2',
      }),
    });
    assert.equal(dupRes.status, 409);
  } finally {
    server.close();
    await holder.current.close();
  }
});

test('Settings updates username, business details, password, and supports username login', async () => {
  const { holder, server, baseUrl } = await startTestServer();
  try {
    const client = new CookieClient(baseUrl);
    const reg = await client.request<{ user: { businessId: number } }>('/api/auth/register', {
      method: 'POST',
      body: {
        businessName: 'Original Tailors',
        ownerName: 'Mary Njeri',
        email: 'mary@tailors.test',
        phone: '0744111222',
        password: 'password123',
        confirmPassword: 'password123',
      },
    });
    assert.equal(reg.status, 201);

    // Update profile + set username + receipt details
    const profRes = await client.request<{
      user: { fullName: string; username: string; businessName: string; businessAddress: string; receiptFooter: string };
    }>('/api/settings/profile', {
      method: 'PUT',
      body: {
        fullName: 'Mary Njeri Kamau',
        username: 'mary.njeri',
        email: 'mary@tailors.test',
        phone: '0744111333',
        businessName: 'Njeri Bespoke',
        currency: 'KES',
        businessAddress: 'Moi Avenue, Nairobi',
        receiptFooter: 'Goods once tailored cannot be returned.',
      },
    });
    assert.equal(profRes.status, 200);
    assert.equal(profRes.data.user.username, 'mary.njeri');
    assert.equal(profRes.data.user.businessName, 'Njeri Bespoke');
    assert.equal(profRes.data.user.businessAddress, 'Moi Avenue, Nairobi');

    // Wrong current password rejected
    const badPwd = await client.request('/api/settings/password', {
      method: 'PUT',
      body: {
        currentPassword: 'wrongpassword',
        newPassword: 'newpassword456',
        confirmPassword: 'newpassword456',
      },
    });
    assert.equal(badPwd.status, 401);

    // Valid password change succeeds
    const goodPwd = await client.request('/api/settings/password', {
      method: 'PUT',
      body: {
        currentPassword: 'password123',
        newPassword: 'newpassword456',
        confirmPassword: 'newpassword456',
      },
    });
    assert.equal(goodPwd.status, 200);

    // Login using username + new password works
    const loginClient = new CookieClient(baseUrl);
    const loginRes = await loginClient.request<{ user: { username: string; businessName: string } }>('/api/auth/login', {
      method: 'POST',
      body: {
        email: 'mary.njeri',
        password: 'newpassword456',
      },
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginRes.data.user.username, 'mary.njeri');
    assert.equal(loginRes.data.user.businessName, 'Njeri Bespoke');
  } finally {
    server.close();
    await holder.current.close();
  }
});

test('Production-only order creation, POS billing calculation, cancellation, and atomic order deletion', async () => {
  const { holder, server, baseUrl } = await startTestServer();
  try {
    const client = new CookieClient(baseUrl);
    await client.request('/api/auth/register', {
      method: 'POST',
      body: {
        businessName: 'Bespoke Workshop',
        ownerName: 'David Otieno',
        email: 'david@workshop.test',
        phone: '0755111222',
        password: 'password123',
        confirmPassword: 'password123',
      },
    });

    const cust = await client.request<{ customer: { id: number } }>('/api/customers', {
      method: 'POST',
      body: { fullName: 'Esther Wanjiku', phone: '0755333444' },
    });
    assert.equal(cust.status, 201);

    const mat = await client.request<{ material: { id: number } }>('/api/materials', {
      method: 'POST',
      body: {
        name: 'Charcoal Cashmere',
        category: 'Suit Fabric',
        unit: 'meters',
        purchasePrice: 2500,
        currentQty: 10,
        minStockLevel: 2,
      },
    });
    assert.equal(mat.status, 201);

    // 1. Create production-only order without price/payment (done later in POS)
    const ord = await client.request<{ order: { id: number; agreed_price: number; status: string } }>('/api/orders', {
      method: 'POST',
      body: {
        customerId: cust.data.customer.id,
        garmentType: 'Suit',
        quantity: 2,
      },
    });
    assert.equal(ord.status, 201);
    assert.equal(ord.data.order.agreed_price, 0);
    assert.equal(ord.data.order.status, 'Pending');

    // 2. Price & calculate order in POS (e.g. 2 * 9500 - 1000 = 18000, labour 2500, other 500)
    const billRes = await client.request<{
      order: { agreed_price: number; labour_cost: number; other_expenses: number };
    }>(`/api/orders/${ord.data.order.id}`, {
      method: 'PATCH',
      body: {
        agreedPrice: 18000,
        labourCost: 2500,
        otherExpenses: 500,
      },
    });
    assert.equal(billRes.status, 200);
    assert.equal(billRes.data.order.agreed_price, 18000);
    assert.equal(billRes.data.order.labour_cost, 2500);
    assert.equal(billRes.data.order.other_expenses, 500);

    // 3. Collect payment in POS
    const payRes = await client.request('/api/payments', {
      method: 'POST',
      body: { orderId: ord.data.order.id, amount: 7000, paymentMethod: 'Cash', paymentType: 'Deposit' },
    });
    assert.equal(payRes.status, 201);

    // Cannot lower agreedPrice below already collected 7000
    const badPriceRes = await client.request(`/api/orders/${ord.data.order.id}`, {
      method: 'PATCH',
      body: { agreedPrice: 5000 },
    });
    assert.equal(badPriceRes.status, 400);

    // 4. Issue 3m of fabric to the order (current_qty 10 -> 7, reserved_qty 0 -> 3)
    const issueRes = await client.request('/api/material-usage', {
      method: 'POST',
      body: { orderId: ord.data.order.id, materialId: mat.data.material.id, issuedQty: 3 },
    });
    assert.equal(issueRes.status, 201);

    // 5. Cancel the order -> blocks any new POS payment
    const cancelRes = await client.request<{ order: { status: string } }>(`/api/orders/${ord.data.order.id}`, {
      method: 'PATCH',
      body: { status: 'Cancelled' },
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.order.status, 'Cancelled');

    const blockedPay = await client.request('/api/payments', {
      method: 'POST',
      body: { orderId: ord.data.order.id, amount: 1000, paymentMethod: 'Cash', paymentType: 'Partial' },
    });
    assert.equal(blockedPay.status, 400);

    // 6. Delete the order -> removes order + payments and restores unsettled 3m back to inventory
    const delRes = await client.request<{ deleted: boolean }>(`/api/orders/${ord.data.order.id}`, {
      method: 'DELETE',
    });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.deleted, true);

    const getDeleted = await client.request(`/api/orders/${ord.data.order.id}`);
    assert.equal(getDeleted.status, 404);

    const matsAfter = await client.request<{ materials: Array<{ current_qty: number; reserved_qty: number }> }>(
      '/api/materials'
    );
    assert.equal(matsAfter.data.materials[0].current_qty, 10);
    assert.equal(matsAfter.data.materials[0].reserved_qty, 0);

    const paysAfter = await client.request<{ payments: Array<unknown> }>('/api/payments');
    assert.equal(paysAfter.data.payments.length, 0);
  } finally {
    server.close();
    await holder.current.close();
  }
});

test('buildPdfBlob generates valid PDF binaries for receipts, order sheets, and reports', async () => {
  const receiptBlob = buildPdfBlob({
    title: 'Savile Workshop',
    subtitle: 'Moi Avenue, Nairobi · Official Tailoring Payment Receipt',
    meta: 'Receipt No: RCP-0001',
    compactReceipt: true,
    sections: [
      {
        title: 'Transaction Details',
        rows: [
          { label: 'Customer', value: 'Peter Kamau' },
          { label: 'Order Reference', value: 'ORD-0001' },
          { label: 'Payment Method', value: 'M-Pesa (Deposit)' },
        ],
      },
    ],
    totalRow: { label: 'Amount Paid', value: 'KES 6,000.00' },
    footer: 'Thank you for choosing our tailoring workshop.',
  });
  const receiptHeader = await receiptBlob.slice(0, 5).text();
  assert.equal(receiptHeader, '%PDF-');
  assert.ok(receiptBlob.size > 500);

  const reportBlob = buildPdfBlob({
    title: 'Savile Workshop — Sales Report',
    subtitle: 'All dates · All categories',
    kpis: [
      { label: 'Total Sales Value', value: 'KES 48,000.00' },
      { label: 'Payments Collected', value: 'KES 32,000.00' },
      { label: 'Outstanding', value: 'KES 16,000.00' },
    ],
    tables: [
      {
        headers: ['Order', 'Customer', 'Sale Value', 'Paid', 'Balance'],
        rows: [
          ['ORD-0001', 'Peter Kamau', 'KES 18,000.00', 'KES 12,000.00', 'KES 6,000.00'],
          ['ORD-0002', 'Esther Wanjiku', 'KES 30,000.00', 'KES 20,000.00', 'KES 10,000.00'],
        ],
        numericColumns: [2, 3, 4],
      },
    ],
  });
  const reportHeader = await reportBlob.slice(0, 5).text();
  assert.equal(reportHeader, '%PDF-');
  assert.ok(reportBlob.size > 500);
});

test('Portable scrypt & HMAC crypto matches server crypto for cross-device backup compatibility', () => {
  const password = 'WorkshopSecret!2026';
  const serverHash = hashPassword(password);
  assert.equal(verifyPasswordPortable(password, serverHash), true);
  assert.equal(verifyPasswordPortable('wrong', serverHash), false);

  const mobileHash = hashPasswordPortable(password);
  assert.equal(verifyPassword(password, mobileHash), true);
  assert.equal(verifyPassword('wrong', mobileHash), false);

  const sampleToken = '0123456789abcdef0123456789abcdef';
  assert.equal(hashTokenPortable(sampleToken), hashToken(sampleToken));
});

test('Android sql.js offline backend executes POS workflow and backup/restore end-to-end', async () => {
  const backend = await createMobileBackend(createInMemoryPersistenceAdapter());

  const health = await backend.dispatch({ method: 'GET', url: '/api/health' });
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, {
    status: 'ok',
    app: 'SmartTailoringSystem',
    platform: 'android',
    dialect: 'sqlite',
    schemaVersion: 2,
  });

  const reg = await backend.dispatch({
    method: 'POST',
    url: '/api/auth/register',
    body: {
      businessName: 'Mobile Stitch Atelier',
      ownerName: 'Amina Hassan',
      email: 'amina@mobilestitch.test',
      phone: '0799111222',
      password: 'password123',
      confirmPassword: 'password123',
    },
  });
  assert.equal(reg.status, 201);
  const regBody = reg.body as { user: { csrfToken: string; sessionToken: string } };
  assert.ok(regBody.user.sessionToken);
  assert.ok(regBody.user.csrfToken);

  const authHeaders = {
    Authorization: `Bearer ${regBody.user.sessionToken}`,
    'X-CSRF-Token': regBody.user.csrfToken,
  };

  // CSRF check blocks missing X-CSRF-Token even when Bearer session token is valid
  const blocked = await backend.dispatch({
    method: 'POST',
    url: '/api/customers',
    headers: { Authorization: `Bearer ${regBody.user.sessionToken}` },
    body: { fullName: 'CSRF Blocked', phone: '0799000001' },
  });
  assert.equal(blocked.status, 403);

  // Create customer, order, and Manual M-Pesa payment
  const cust = await backend.dispatch({
    method: 'POST',
    url: '/api/customers',
    headers: authHeaders,
    body: { fullName: 'Fatuma Ali', phone: '0799333444' },
  });
  assert.equal(cust.status, 201);
  const custId = (cust.body as { customer: { id: number } }).customer.id;

  const order = await backend.dispatch({
    method: 'POST',
    url: '/api/orders',
    headers: authHeaders,
    body: {
      customerId: custId,
      garmentType: 'Kanzu',
      agreedPrice: 8500,
      depositAmount: 3500,
    },
  });
  assert.equal(order.status, 201);
  const orderId = (order.body as { order: { id: number } }).order.id;

  const pay = await backend.dispatch({
    method: 'POST',
    url: '/api/payments',
    headers: authHeaders,
    body: {
      orderId,
      amount: 5000,
      paymentMethod: 'M-Pesa',
      paymentType: 'Final',
      mpesaReference: 'UAT998877',
    },
  });
  assert.equal(pay.status, 201);

  // Export .db binary backup from sql.js
  const exported = await backend.dispatch({
    method: 'GET',
    url: '/api/backup/export',
    headers: authHeaders,
  });
  assert.equal(exported.status, 200);
  const backupBytes = exported.body as Uint8Array;
  assert.ok(backupBytes instanceof Uint8Array);
  assert.equal(Buffer.from(backupBytes.slice(0, 16)).toString('utf8'), 'SQLite format 3\0');

  // Validate backup bytes
  const validated = await backend.dispatch({
    method: 'POST',
    url: '/api/backup/validate',
    headers: authHeaders,
    body: backupBytes,
  });
  assert.equal(validated.status, 200);
  const valBody = validated.body as { valid: boolean; summary?: { customers: number; orders: number; payments: number } };
  assert.equal(valBody.valid, true);
  assert.equal(valBody.summary?.customers, 1);
  assert.equal(valBody.summary?.orders, 1);
  assert.equal(valBody.summary?.payments, 2);

  // Add second customer after backup
  const cust2 = await backend.dispatch({
    method: 'POST',
    url: '/api/customers',
    headers: authHeaders,
    body: { fullName: 'Post Backup Client', phone: '0799555666' },
  });
  assert.equal(cust2.status, 201);

  // Restore snapshot -> reverts customer list back to 1
  const restored = await backend.dispatch({
    method: 'POST',
    url: '/api/backup/restore',
    headers: authHeaders,
    body: backupBytes,
  });
  assert.equal(restored.status, 200);
  assert.equal((restored.body as { restored: boolean }).restored, true);

  const customersAfter = await backend.dispatch({
    method: 'GET',
    url: '/api/customers',
    headers: authHeaders,
  });
  assert.equal(customersAfter.status, 200);
  const list = (customersAfter.body as { customers: Array<{ full_name: string }> }).customers;
  assert.equal(list.length, 1);
  assert.equal(list[0].full_name, 'Fatuma Ali');
});
