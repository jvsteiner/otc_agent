import { Deal, DealStage } from '@otc-broker/core';
import { DB } from '../database';
import * as crypto from 'crypto';

export class DealRepository {
  constructor(private db: DB) {}

  create(deal: Omit<Deal, 'id' | 'createdAt' | 'outQueue' | 'refundQueue' | 'events'>): Deal {
    const id = crypto.randomBytes(16).toString('hex');
    const createdAt = new Date().toISOString();
    
    const newDeal: Deal = {
      ...deal,
      id,
      createdAt,
      outQueue: [],
      refundQueue: [],
      events: [],
    };
    
    const stmt = this.db.prepare(`
      INSERT INTO deals (dealId, stage, json, createdAt, expiresAt)
      VALUES (?, ?, ?, ?, ?)
    `);
    
    stmt.run(
      newDeal.id,
      newDeal.stage,
      JSON.stringify(newDeal),
      newDeal.createdAt,
      newDeal.expiresAt || null
    );
    
    return newDeal;
  }

  get(dealId: string): Deal | null {
    const stmt = this.db.prepare('SELECT json FROM deals WHERE dealId = ?');
    const row = stmt.get(dealId) as { json: string } | undefined;
    
    if (!row) return null;
    return JSON.parse(row.json);
  }

  update(deal: Deal): void {
    const stmt = this.db.prepare(`
      UPDATE deals 
      SET stage = ?, json = ?, expiresAt = ?
      WHERE dealId = ?
    `);
    
    stmt.run(
      deal.stage,
      JSON.stringify(deal),
      deal.expiresAt || null,
      deal.id
    );
  }

  updateStage(dealId: string, newStage: DealStage): void {
    this.db.runInTransaction(() => {
      const deal = this.get(dealId);
      if (!deal) throw new Error(`Deal ${dealId} not found`);
      
      deal.stage = newStage;
      this.update(deal);
      
      // Add event
      this.addEvent(dealId, `Stage changed to ${newStage}`);
    });
  }

  addEvent(dealId: string, msg: string): void {
    const stmt = this.db.prepare(`
      INSERT INTO events (dealId, t, msg)
      VALUES (?, ?, ?)
    `);
    
    stmt.run(dealId, new Date().toISOString(), msg);
  }

  getActiveDeals(): Deal[] {
    const stmt = this.db.prepare(`
      SELECT json FROM deals 
      WHERE stage IN ('CREATED', 'COLLECTION', 'WAITING')
    `);
    
    const rows = stmt.all() as { json: string }[];
    return rows.map(row => JSON.parse(row.json));
  }

  getExpiredDeals(): Deal[] {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT json FROM deals 
      WHERE stage = 'COLLECTION' 
      AND expiresAt < ?
    `);
    
    const rows = stmt.all(now) as { json: string }[];
    return rows.map(row => JSON.parse(row.json));
  }
}