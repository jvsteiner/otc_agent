import { DB } from '../database';

export interface Lease {
  dealId: string;
  ownerId: string;
  leaseUntil: string;
}

export class LeaseRepository {
  constructor(private db: DB) {}

  acquire(dealId: string, ownerId: string, durationMs: number = 90000): boolean {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + durationMs).toISOString();
    
    try {
      // Try to acquire or extend existing lease
      const stmt = this.db.prepare(`
        INSERT INTO leases (dealId, ownerId, leaseUntil)
        VALUES (?, ?, ?)
        ON CONFLICT(dealId) DO UPDATE SET
          ownerId = CASE
            WHEN leases.leaseUntil < ? OR leases.ownerId = ?
            THEN excluded.ownerId
            ELSE leases.ownerId
          END,
          leaseUntil = CASE
            WHEN leases.leaseUntil < ? OR leases.ownerId = ?
            THEN excluded.leaseUntil
            ELSE leases.leaseUntil
          END
      `);
      
      const result = stmt.run(
        dealId,
        ownerId,
        leaseUntil,
        now.toISOString(),
        ownerId,
        now.toISOString(),
        ownerId
      );
      
      // Check if we actually got the lease
      const checkStmt = this.db.prepare('SELECT ownerId FROM leases WHERE dealId = ?');
      const row = checkStmt.get(dealId) as { ownerId: string } | undefined;
      
      return row?.ownerId === ownerId;
    } catch (error) {
      console.error('Failed to acquire lease:', error);
      return false;
    }
  }

  extend(dealId: string, ownerId: string, durationMs: number = 90000): boolean {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + durationMs).toISOString();
    
    const stmt = this.db.prepare(`
      UPDATE leases
      SET leaseUntil = ?
      WHERE dealId = ? AND ownerId = ? AND leaseUntil > ?
    `);
    
    const result = stmt.run(leaseUntil, dealId, ownerId, now.toISOString());
    return result.changes > 0;
  }

  release(dealId: string, ownerId: string): boolean {
    const stmt = this.db.prepare(`
      DELETE FROM leases
      WHERE dealId = ? AND ownerId = ?
    `);
    
    const result = stmt.run(dealId, ownerId);
    return result.changes > 0;
  }

  getLease(dealId: string): Lease | null {
    const stmt = this.db.prepare('SELECT * FROM leases WHERE dealId = ?');
    const row = stmt.get(dealId) as Lease | undefined;
    return row || null;
  }

  cleanupExpired(): number {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('DELETE FROM leases WHERE leaseUntil < ?');
    const result = stmt.run(now);
    return result.changes;
  }
}