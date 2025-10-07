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
    
    const deal = JSON.parse(row.json) as Deal;
    
    // Load party details from database if they exist
    try {
      const checkTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='party_details'");
      const tableExists = checkTable.get();
      
      if (tableExists) {
        const partyStmt = this.db.prepare(`
          SELECT party, paybackAddress, recipientAddress, email, filledAt, locked, escrowAddress, escrowKeyRef
          FROM party_details 
          WHERE dealId = ?
        `);
        
        const partyRows = partyStmt.all(dealId) as any[];
        
        for (const partyRow of partyRows) {
          const details = {
            paybackAddress: partyRow.paybackAddress,
            recipientAddress: partyRow.recipientAddress,
            email: partyRow.email,
            filledAt: partyRow.filledAt,
            locked: partyRow.locked === 1,
          };
          
          if (partyRow.party === 'ALICE') {
            deal.aliceDetails = details;
            if (partyRow.escrowAddress) {
              deal.escrowA = {
                chainId: deal.alice.chainId,
                address: partyRow.escrowAddress,
                keyRef: partyRow.escrowKeyRef,
              };
            }
          } else if (partyRow.party === 'BOB') {
            deal.bobDetails = details;
            if (partyRow.escrowAddress) {
              deal.escrowB = {
                chainId: deal.bob.chainId,
                address: partyRow.escrowAddress,
                keyRef: partyRow.escrowKeyRef,
              };
            }
          }
        }
      }
    } catch (error) {
      // If party_details table doesn't exist or error loading, continue with deal from JSON
      console.warn('Could not load party details from database:', error);
    }
    
    return deal;
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
      WHERE stage IN ('CREATED', 'COLLECTION', 'WAITING', 'SWAP', 'CLOSED', 'REVERTED')
    `);
    
    const rows = stmt.all() as { json: string }[];
    return rows.map(row => {
      const deal = JSON.parse(row.json) as Deal;
      
      // Load party details from database if they exist
      try {
        const checkTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='party_details'");
        const tableExists = checkTable.get();
        
        if (tableExists) {
          const partyStmt = this.db.prepare(`
            SELECT party, paybackAddress, recipientAddress, email, filledAt, locked, escrowAddress, escrowKeyRef
            FROM party_details 
            WHERE dealId = ?
          `);
          
          const partyRows = partyStmt.all(deal.id) as any[];
          
          for (const partyRow of partyRows) {
            const details = {
              paybackAddress: partyRow.paybackAddress,
              recipientAddress: partyRow.recipientAddress,
              email: partyRow.email,
              filledAt: partyRow.filledAt,
              locked: partyRow.locked === 1,
            };
            
            if (partyRow.party === 'ALICE') {
              deal.aliceDetails = details;
              if (partyRow.escrowAddress) {
                deal.escrowA = {
                  chainId: deal.alice.chainId,
                  address: partyRow.escrowAddress,
                  keyRef: partyRow.escrowKeyRef,
                };
              }
            } else if (partyRow.party === 'BOB') {
              deal.bobDetails = details;
              if (partyRow.escrowAddress) {
                deal.escrowB = {
                  chainId: deal.bob.chainId,
                  address: partyRow.escrowAddress,
                  keyRef: partyRow.escrowKeyRef,
                };
              }
            }
          }
        }
      } catch (error) {
        // If party_details table doesn't exist or error loading, continue with deal from JSON
        console.warn('Could not load party details from database for deal', deal.id, ':', error);
      }
      
      return deal;
    });
  }

  getExpiredDeals(): Deal[] {
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`
      SELECT json FROM deals 
      WHERE stage = 'COLLECTION' 
      AND expiresAt < ?
    `);
    
    const rows = stmt.all(now) as { json: string }[];
    return rows.map(row => {
      const deal = JSON.parse(row.json) as Deal;
      
      // Load party details from database if they exist
      try {
        const checkTable = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='party_details'");
        const tableExists = checkTable.get();
        
        if (tableExists) {
          const partyStmt = this.db.prepare(`
            SELECT party, paybackAddress, recipientAddress, email, filledAt, locked, escrowAddress, escrowKeyRef
            FROM party_details 
            WHERE dealId = ?
          `);
          
          const partyRows = partyStmt.all(deal.id) as any[];
          
          for (const partyRow of partyRows) {
            const details = {
              paybackAddress: partyRow.paybackAddress,
              recipientAddress: partyRow.recipientAddress,
              email: partyRow.email,
              filledAt: partyRow.filledAt,
              locked: partyRow.locked === 1,
            };
            
            if (partyRow.party === 'ALICE') {
              deal.aliceDetails = details;
              if (partyRow.escrowAddress) {
                deal.escrowA = {
                  chainId: deal.alice.chainId,
                  address: partyRow.escrowAddress,
                  keyRef: partyRow.escrowKeyRef,
                };
              }
            } else if (partyRow.party === 'BOB') {
              deal.bobDetails = details;
              if (partyRow.escrowAddress) {
                deal.escrowB = {
                  chainId: deal.bob.chainId,
                  address: partyRow.escrowAddress,
                  keyRef: partyRow.escrowKeyRef,
                };
              }
            }
          }
        }
      } catch (error) {
        // If party_details table doesn't exist or error loading, continue with deal from JSON
        console.warn('Could not load party details from database for deal', deal.id, ':', error);
      }
      
      return deal;
    });
  }
}