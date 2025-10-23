/**
 * @fileoverview Admin route handlers for OTC Broker Engine.
 * Provides authentication and administrative functionality.
 */

import express, { Request, Response } from 'express';
import { DB } from '../db/database';
import { PluginManager } from '@otc-broker/chains';
import { AdminService } from '../services/AdminService';
import { adminLogin, adminLogout, requireAdmin } from '../middleware/adminAuth';
import {
  renderAdminLoginPage,
  renderDealsListPage,
  renderDealDetailsPage,
  renderAccountsPage,
} from './admin-pages';

/**
 * Sets up admin routes on an Express app
 */
export function setupAdminRoutes(
  app: express.Application,
  db: DB,
  pluginManager: PluginManager
) {
  const adminService = new AdminService(db, pluginManager);

  /**
   * GET /admin/login - Login page
   */
  app.get('/admin/login', (req: Request, res: Response) => {
    const error = req.query.error as string | undefined;
    res.send(renderAdminLoginPage(error));
  });

  /**
   * POST /admin/login - Handle login
   */
  app.post('/admin/login', express.urlencoded({ extended: true }), adminLogin);

  /**
   * POST /admin/logout - Handle logout
   */
  app.post('/admin/logout', adminLogout);

  /**
   * GET /admin/deals - List all deals
   */
  app.get('/admin/deals', requireAdmin, (req: Request, res: Response) => {
    try {
      const deals = adminService.getAllDeals();
      res.send(renderDealsListPage(deals));
    } catch (error: any) {
      res.status(500).send(`
        <html>
          <body style="background: #1a1a2e; color: white; padding: 40px; font-family: sans-serif;">
            <h1>Error</h1>
            <p>${error.message}</p>
            <a href="/admin/deals" style="color: #00d4ff;">Try again</a>
          </body>
        </html>
      `);
    }
  });

  /**
   * GET /admin/deals/:id - Deal details
   */
  app.get('/admin/deals/:id', requireAdmin, async (req: Request, res: Response): Promise<void> => {
    try {
      const dealDetails = await adminService.getDealDetails(req.params.id);
      res.send(renderDealDetailsPage(dealDetails.deal, dealDetails.balances));
    } catch (error: any) {
      if (error.message === 'Deal not found') {
        res.status(404).send(`
          <html>
            <body style="background: #1a1a2e; color: white; padding: 40px; font-family: sans-serif;">
              <h1>Deal Not Found</h1>
              <p>The requested deal does not exist.</p>
              <a href="/admin/deals" style="color: #00d4ff;">Back to deals</a>
            </body>
          </html>
        `);
        return;
      }

      res.status(500).send(`
        <html>
          <body style="background: #1a1a2e; color: white; padding: 40px; font-family: sans-serif;">
            <h1>Error</h1>
            <p>${error.message}</p>
            <a href="/admin/deals" style="color: #00d4ff;">Back to deals</a>
          </body>
        </html>
      `);
    }
  });

  /**
   * POST /admin/deals/:id/spend - Execute manual spend from escrow
   */
  app.post(
    '/admin/deals/:id/spend',
    requireAdmin,
    express.urlencoded({ extended: true }),
    async (req: Request, res: Response) => {
      try {
        const { chainId, escrowAddress, toAddress, asset, amount, reason } = req.body;

        // Validate inputs
        if (!chainId || !escrowAddress || !toAddress || !asset || !amount) {
          throw new Error('All fields are required');
        }

        const result = await adminService.spendFromEscrow({
          dealId: req.params.id,
          chainId,
          escrowAddress,
          toAddress,
          asset,
          amount,
          reason: reason || 'Manual admin intervention'
        });

        res.send(`
          <html>
            <head>
              <meta http-equiv="refresh" content="2;url=/admin/deals/${req.params.id}">
              <style>
                body {
                  background: #1a1a2e;
                  color: white;
                  padding: 40px;
                  font-family: sans-serif;
                  text-align: center;
                }
                .success {
                  color: #75fb8a;
                  font-size: 24px;
                  margin: 20px 0;
                }
              </style>
            </head>
            <body>
              <h1>Spend Request Submitted</h1>
              <div class="success">✓ ${result.message}</div>
              <p>Queue Item ID: ${result.queueItemId}</p>
              <p>Redirecting back to deal details...</p>
              <p><a href="/admin/deals/${req.params.id}" style="color: #00d4ff;">Click here if not redirected</a></p>
            </body>
          </html>
        `);
      } catch (error: any) {
        res.status(500).send(`
          <html>
            <body style="background: #1a1a2e; color: white; padding: 40px; font-family: sans-serif;">
              <h1>Error</h1>
              <p style="color: #ff6b6b;">${error.message}</p>
              <a href="/admin/deals/${req.params.id}" style="color: #00d4ff;">Back to deal</a>
            </body>
          </html>
        `);
      }
    }
  );

  /**
   * GET /admin/accounts - Show account balances
   */
  app.get('/admin/accounts', requireAdmin, async (req: Request, res: Response) => {
    try {
      const accountBalances = await adminService.getOperatorBalances();
      res.send(renderAccountsPage(accountBalances));
    } catch (error: any) {
      res.status(500).send(`
        <html>
          <body style="background: #1a1a2e; color: white; padding: 40px; font-family: sans-serif;">
            <h1>Error</h1>
            <p>${error.message}</p>
            <a href="/admin/deals" style="color: #00d4ff;">Back to dashboard</a>
          </body>
        </html>
      `);
    }
  });
}
