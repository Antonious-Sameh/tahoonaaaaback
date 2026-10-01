import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';

vi.mock('../../src/services/product.service.js', () => ({
  listProducts: vi.fn(),
  getProduct: vi.fn(),
}));
vi.mock('../../src/services/sale.service.js', () => ({
  listSales: vi.fn(),
  getSale: vi.fn(),
  createSale: vi.fn(),
}));
vi.mock('../../src/services/purchase.service.js', () => ({
  listPurchases: vi.fn(),
  getPurchase: vi.fn(),
  createPurchase: vi.fn(),
}));
vi.mock('../../src/services/cashbox.service.js', () => ({
  listCashboxTransactions: vi.fn(),
  getSummary: vi.fn(),
  createCashTransaction: vi.fn(),
}));
vi.mock('../../src/services/dailyReport.service.js', () => ({
  getDailyReport: vi.fn(),
}));

vi.mock('../../src/services/expense.service.js', () => ({
  listExpenses: vi.fn(),
  getSummary: vi.fn(),
  getDistinctReasons: vi.fn(),
  createExpense: vi.fn(),
  deleteExpense: vi.fn(),
}));
vi.mock('../../src/services/reports.service.js', () => ({
  getSalesReport: vi.fn(),
  getPurchasesReport: vi.fn(),
  getProfitReport: vi.fn(),
  getInventoryReport: vi.fn(),
  getCustomersReport: vi.fn(),
  getSuppliersReport: vi.fn(),
}));
vi.mock('../../src/services/activityLog.service.js', () => ({
  listActivity: vi.fn(),
  recordActivity: vi.fn(),
}));
vi.mock('../../src/services/auditLog.service.js', () => ({
  listAuditLogs: vi.fn(),
  recordAuditLog: vi.fn(),
}));
vi.mock('../../src/services/settings.service.js', () => ({
  getSettings: vi.fn(),
  updateSettings: vi.fn(),
}));
vi.mock('../../src/services/customer.service.js', () => ({
  customerService: { list: vi.fn(), getOne: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));
vi.mock('../../src/services/supplier.service.js', () => ({
  supplierService: { list: vi.fn(), getOne: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));

const productService = await import('../../src/services/product.service.js');
const saleService = await import('../../src/services/sale.service.js');
const cashboxService = await import('../../src/services/cashbox.service.js');
const reportsService = await import('../../src/services/reports.service.js');
const expenseService = await import('../../src/services/expense.service.js');
const dailyReportService = await import('../../src/services/dailyReport.service.js');
const { customerService } = await import('../../src/services/customer.service.js');
const { createApp } = await import('../../src/app.js');

const ADMIN_KEY = process.env.ADMIN_READONLY_KEY;
const adminHeader = (key = ADMIN_KEY) => ({ 'X-Admin-Key': key });
const validId = () => new mongoose.Types.ObjectId().toString();

beforeEach(() => {
  vi.clearAllMocks();
});

describe('/api/admin access control', () => {
  it('rejects requests with no key', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/products');
    expect(res.status).toBe(401);
    expect(productService.listProducts).not.toHaveBeenCalled();
  });

  it('rejects requests with a wrong key', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/products').set(adminHeader('totally-wrong'));
    expect(res.status).toBe(401);
  });

  it("does not accept a normal shop login token in place of the admin key", async () => {
    const { signAccessToken } = await import('../../src/config/jwt.js');
    const app = createApp();
    const res = await request(app)
      .get('/api/admin/products')
      .set('Authorization', `Bearer ${signAccessToken({ deviceId: 'd1' })}`);
    expect(res.status).toBe(401);
  });

  it('allows a request with the correct admin key', async () => {
    productService.listProducts.mockResolvedValue({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });
    const app = createApp();
    const res = await request(app).get('/api/admin/products').set(adminHeader());
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });
});

describe('/api/admin is strictly read-only', () => {
  it('has no route registered for POST/PATCH/PUT/DELETE on any admin path', async () => {
    const app = createApp();
    const id = validId();

    const writesRejected = await Promise.all([
      request(app).post('/api/admin/products').set(adminHeader()).send({ name: 'x' }),
      request(app).patch(`/api/admin/products/${id}`).set(adminHeader()).send({ name: 'x' }),
      request(app).delete(`/api/admin/products/${id}`).set(adminHeader()),
      request(app).post('/api/admin/sales').set(adminHeader()).send({}),
      request(app).post('/api/admin/expenses').set(adminHeader()).send({}),
      request(app).delete(`/api/admin/expenses/${id}`).set(adminHeader()),
      request(app).patch('/api/admin/settings').set(adminHeader()).send({ shopName: 'x' }),
      request(app).post(`/api/admin/customers`).set(adminHeader()).send({ name: 'x' }),
      request(app).post('/api/admin/expenses/reasons').set(adminHeader()).send({ reason: 'x' }),
      request(app).post('/api/admin/reports/daily').set(adminHeader()).send({}),
    ]);

    // Express falls through to notFoundHandler (404) for a verb with no
    // matching route on that path — none of these should ever reach a
    // controller or mutate anything.
    writesRejected.forEach((res) => expect(res.status).toBe(404));

    expect(productService.listProducts).not.toHaveBeenCalled();
    expect(saleService.createSale).not.toHaveBeenCalled();
    expect(cashboxService.createCashTransaction).not.toHaveBeenCalled();
    expect(customerService.create).not.toHaveBeenCalled();
  });
});

describe('/api/admin data coverage', () => {
  it('exposes product detail via the same controller as the authenticated route', async () => {
    const id = validId();
    productService.getProduct.mockResolvedValue({ _id: id, name: 'فلتر زيت' });

    const app = createApp();
    const res = await request(app).get(`/api/admin/products/${id}`).set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('فلتر زيت');
    expect(productService.getProduct).toHaveBeenCalledWith(id);
  });

  it('exposes paginated sales list', async () => {
    saleService.listSales.mockResolvedValue({
      items: [{ invoiceNumber: 1 }],
      pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
    });

    const app = createApp();
    const res = await request(app).get('/api/admin/sales').set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('exposes customers via the same personService used by the authenticated route', async () => {
    customerService.list.mockResolvedValue({ items: [{ name: 'أحمد' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } });

    const app = createApp();
    const res = await request(app).get('/api/admin/customers').set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.data[0].name).toBe('أحمد');
  });

  it('exposes the cashbox summary', async () => {
    cashboxService.getSummary.mockResolvedValue({ balance: 500 });

    const app = createApp();
    const res = await request(app).get('/api/admin/cashbox/summary').set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(500);
  });

  it('exposes the profit report', async () => {
    reportsService.getProfitReport.mockResolvedValue({ totalProfit: 1000 });

    const app = createApp();
    const res = await request(app).get('/api/admin/reports/profit').set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.data.totalProfit).toBe(1000);
  });
});

describe('/api/admin expense reasons (for System 5\'s expense filter)', () => {
  it('returns the distinct reasons via the same service the shop\'s own ExpensesPage uses', async () => {
    expenseService.getDistinctReasons.mockResolvedValue(['إيجار', 'كهرباء']);

    const app = createApp();
    const res = await request(app).get('/api/admin/expenses/reasons').set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, data: ['إيجار', 'كهرباء'] });
    expect(expenseService.getDistinctReasons).toHaveBeenCalledTimes(1);
  });

  it('is gated by the admin key like every other admin route', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/expenses/reasons');

    expect(res.status).toBe(401);
    expect(expenseService.getDistinctReasons).not.toHaveBeenCalled();
  });

  it('does not shadow /expenses/summary', async () => {
    expenseService.getSummary.mockResolvedValue({ total: 10 });

    const app = createApp();
    const res = await request(app).get('/api/admin/expenses/summary').set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(10);
    expect(expenseService.getDistinctReasons).not.toHaveBeenCalled();
  });
});

describe('/api/admin rate limit', () => {
  it('no longer blocks System 5 after 60 requests (the old cap)', async () => {
    productService.listProducts.mockResolvedValue({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });

    const app = createApp();
    const statuses = [];
    for (let i = 0; i < 75; i += 1) {
      const res = await request(app).get('/api/admin/products').set(adminHeader());
      statuses.push(res.status);
    }

    expect(statuses.filter((s) => s === 429)).toHaveLength(0);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });

  it('still caps the admin router (at 300 per 15 minutes)', async () => {
    const { ADMIN_RATE_LIMIT_MAX } = await import('../../src/routes/admin.route.js');
    productService.listProducts.mockResolvedValue({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } });

    const app = createApp();
    const res = await request(app).get('/api/admin/products').set(adminHeader());

    expect(ADMIN_RATE_LIMIT_MAX).toBe(300);
    expect(res.headers['ratelimit-limit']).toBe(String(ADMIN_RATE_LIMIT_MAX));
    // The admin router (and its limiter) is a module-level singleton shared
    // by every createApp() in this file, so earlier tests already consumed
    // part of the window — only assert it is counting down from the cap.
    expect(Number(res.headers['ratelimit-remaining'])).toBeLessThan(ADMIN_RATE_LIMIT_MAX);
  });

  it('does not change the limits on the shop\'s own (non-admin) routes', async () => {
    const app = createApp();
    const res = await request(app).get('/api/health');

    expect(res.headers['ratelimit-limit']).toBe('300'); // app-wide limiter, unchanged
  });
});

describe('/api/admin/reports/daily (System 5 trend charts)', () => {
  it('returns the day-by-day series for the range', async () => {
    dailyReportService.getDailyReport.mockResolvedValue({ from: '2026-09-01', to: '2026-09-02', days: [{ date: '2026-09-01' }] });

    const app = createApp();
    const res = await request(app).get('/api/admin/reports/daily?from=2026-09-01&to=2026-09-02').set(adminHeader());

    expect(res.status).toBe(200);
    expect(res.body.data.days).toHaveLength(1);
    expect(dailyReportService.getDailyReport).toHaveBeenCalledWith({ from: '2026-09-01', to: '2026-09-02' });
  });

  it('requires both dates in YYYY-MM-DD', async () => {
    const app = createApp();
    const missing = await request(app).get('/api/admin/reports/daily?from=2026-09-01').set(adminHeader());
    const bad = await request(app).get('/api/admin/reports/daily?from=1-9-2026&to=2026-09-02').set(adminHeader());

    expect(missing.status).toBe(400);
    expect(bad.status).toBe(400);
    expect(dailyReportService.getDailyReport).not.toHaveBeenCalled();
  });

  it('is gated by the admin key', async () => {
    const app = createApp();
    const res = await request(app).get('/api/admin/reports/daily?from=2026-09-01&to=2026-09-02');
    expect(res.status).toBe(401);
  });
});
