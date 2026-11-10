import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';

vi.mock('../../src/services/accountBalanceTransfer.service.js', () => ({
  listAccountBalanceTransfers: vi.fn(),
  createAccountBalanceTransfer: vi.fn(),
}));

const service = await import('../../src/services/accountBalanceTransfer.service.js');
const { createApp } = await import('../../src/app.js');
const { signAccessToken } = await import('../../src/config/jwt.js');

const authHeader = () => ({ Authorization: `Bearer ${signAccessToken({ deviceId: 'd1' })}` });
const validId = () => new mongoose.Types.ObjectId().toString();
const validBody = () => ({
  fromAccountType: 'customer', fromAccountId: validId(), toAccountType: 'supplier', toAccountId: validId(), amount: 100,
});

beforeEach(() => { vi.clearAllMocks(); });

describe('account-balance-transfers routes require authentication', () => {
  it('rejects list and create without a token, and never reaches the service', async () => {
    const app = createApp();
    expect((await request(app).get(`/api/account-balance-transfers?accountType=customer&accountId=${validId()}`)).status).toBe(401);
    expect((await request(app).post('/api/account-balance-transfers').send(validBody())).status).toBe(401);
    expect(service.createAccountBalanceTransfer).not.toHaveBeenCalled();
    expect(service.listAccountBalanceTransfers).not.toHaveBeenCalled();
  });

  it('rejects a malformed / wrongly signed token', async () => {
    const app = createApp();
    const res = await request(app).post('/api/account-balance-transfers').set('Authorization', 'Bearer not.a.jwt').send(validBody());
    expect(res.status).toBe(401);
    expect(service.createAccountBalanceTransfer).not.toHaveBeenCalled();
  });
});

describe('POST /api/account-balance-transfers validation', () => {
  it('rejects bad shapes with 400 before calling the service', async () => {
    const app = createApp();
    const bad = [
      {},
      { ...validBody(), fromAccountType: 'bank' },
      { ...validBody(), fromAccountId: 'nope' },
      { ...validBody(), toAccountId: undefined },
      { ...validBody(), amount: undefined },
      { ...validBody(), amount: '' },
      { ...validBody(), amount: null },
      { ...validBody(), note: 'x'.repeat(501) },
    ];
    for (const body of bad) {
      const res = await request(app).post('/api/account-balance-transfers').set(authHeader()).send(body);
      expect(res.status).toBe(400);
    }
    expect(service.createAccountBalanceTransfer).not.toHaveBeenCalled();
  });

  it('delegates a valid body to the service and answers 201', async () => {
    service.createAccountBalanceTransfer.mockResolvedValue({ _id: 'x', reference: 'ABT-1' });
    const app = createApp();
    const body = { ...validBody(), note: 'ملاحظة', idempotencyKey: 'k1' };
    const res = await request(app).post('/api/account-balance-transfers').set(authHeader()).send(body);
    expect(res.status).toBe(201);
    expect(service.createAccountBalanceTransfer).toHaveBeenCalledWith(expect.objectContaining({ fromAccountType: 'customer', toAccountType: 'supplier', amount: 100, idempotencyKey: 'k1' }));
  });

  it('passes the amount through untouched so the service can reject over-precise / non-numeric values', async () => {
    service.createAccountBalanceTransfer.mockResolvedValue({ _id: 'x' });
    const app = createApp();
    await request(app).post('/api/account-balance-transfers').set(authHeader()).send({ ...validBody(), amount: '10.005' });
    expect(service.createAccountBalanceTransfer).toHaveBeenCalledWith(expect.objectContaining({ amount: '10.005' }));
  });
});

describe('GET /api/account-balance-transfers', () => {
  it('requires a valid accountType and accountId', async () => {
    const app = createApp();
    expect((await request(app).get('/api/account-balance-transfers').set(authHeader())).status).toBe(400);
    expect((await request(app).get(`/api/account-balance-transfers?accountType=x&accountId=${validId()}`).set(authHeader())).status).toBe(400);
    expect((await request(app).get('/api/account-balance-transfers?accountType=customer&accountId=bad').set(authHeader())).status).toBe(400);
    expect(service.listAccountBalanceTransfers).not.toHaveBeenCalled();
  });

  it('applies defaults and delegates', async () => {
    service.listAccountBalanceTransfers.mockResolvedValue({ items: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 1 } });
    const app = createApp();
    const id = validId();
    const res = await request(app).get(`/api/account-balance-transfers?accountType=supplier&accountId=${id}`).set(authHeader());
    expect(res.status).toBe(200);
    expect(service.listAccountBalanceTransfers).toHaveBeenCalledWith(expect.objectContaining({ accountType: 'supplier', accountId: id, page: 1, limit: 20 }));
  });
});

describe('a transfer is permanent', () => {
  it('exposes no update or delete endpoint', async () => {
    const app = createApp();
    const id = validId();
    expect((await request(app).delete(`/api/account-balance-transfers/${id}`).set(authHeader())).status).toBe(404);
    expect((await request(app).patch(`/api/account-balance-transfers/${id}`).set(authHeader()).send({})).status).toBe(404);
    expect((await request(app).put('/api/account-balance-transfers').set(authHeader()).send({})).status).toBe(404);
  });
});
