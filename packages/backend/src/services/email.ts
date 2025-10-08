/**
 * @fileoverview Email service for sending deal invitations and notifications.
 * Supports SMTP configuration or console logging fallback for development.
 */

import * as nodemailer from 'nodemailer';
import { getAssetRegistry, formatAssetCode } from '@otc-broker/core';
import { DB } from '../db/database';
import { DealRepository } from '../db/repositories';

export interface EmailInviteParams {
  dealId: string;
  party: 'ALICE' | 'BOB';
  email: string;
  link: string;
}

/**
 * Service for sending email notifications to deal participants.
 * Falls back to console logging if SMTP is not configured.
 */
export class EmailService {
  private db: DB;
  private transporter?: nodemailer.Transporter;

  constructor(db: DB) {
    this.db = db;
    
    // Initialize transporter if email is enabled
    if (process.env.EMAIL_ENABLED === 'true') {
      this.transporter = nodemailer.createTransport({
        host: process.env.EMAIL_SMTP_HOST || 'smtp.gmail.com',
        port: parseInt(process.env.EMAIL_SMTP_PORT || '587'),
        secure: false, // true for 465, false for other ports
        auth: {
          user: process.env.EMAIL_SMTP_USER,
          pass: process.env.EMAIL_SMTP_PASS
        }
      });
    }
  }

  async sendInvite(params: EmailInviteParams) {
    // Check if email is enabled
    if (!this.transporter) {
      // Get deal name for logging
      const dealRepo = new DealRepository(this.db);
      const deal = dealRepo.get(params.dealId);
      
      console.log(`
        ========================================
        EMAIL INVITATION (Email service not configured)
        ========================================
        To: ${params.email}
        Deal: ${deal?.name || 'Unnamed Deal'}
        Party: ${params.party === 'ALICE' ? 'Asset A Seller' : 'Asset B Seller'}
        Deal ID: ${params.dealId}
        Link: ${params.link}
        ========================================
      `);
      
      return { 
        sent: true, 
        message: 'Invitation logged (email service not configured)',
        email: params.email 
      };
    }

    try {
      // Get deal details for better email content  
      const dealRepo = new DealRepository(this.db);
      const deal = dealRepo.get(params.dealId);
      
      const partyLabel = params.party === 'ALICE' ? 'Asset A' : 'Asset B';
      const otherPartyLabel = params.party === 'ALICE' ? 'Asset B' : 'Asset A';
      
      let dealDetails = '';
      if (deal) {
        const registry = getAssetRegistry();
        const assetA = registry.assets.find(a => a.chainId === deal.alice.chainId && formatAssetCode(a) === deal.alice.asset);
        const assetB = registry.assets.find(a => a.chainId === deal.bob.chainId && formatAssetCode(a) === deal.bob.asset);
        
        const assetADisplay = params.party === 'ALICE' 
          ? `${deal.alice.amount} ${assetA?.assetSymbol || deal.alice.asset} on ${deal.alice.chainId}`
          : `${deal.bob.amount} ${assetB?.assetSymbol || deal.bob.asset} on ${deal.bob.chainId}`;
        
        const assetBDisplay = params.party === 'ALICE'
          ? `${deal.bob.amount} ${assetB?.assetSymbol || deal.bob.asset} on ${deal.bob.chainId}`
          : `${deal.alice.amount} ${assetA?.assetSymbol || deal.alice.asset} on ${deal.alice.chainId}`;
        
        dealDetails = `
          <p><strong>Deal Details:</strong></p>
          <ul>
            <li>Deal Name: ${deal.name}</li>
            <li>You sell: ${assetADisplay}</li>
            <li>You receive: ${assetBDisplay}</li>
            <li>Deal ID: ${params.dealId}</li>
            <li>Expires: ${deal.expiresAt ? new Date(deal.expiresAt).toLocaleString() : 'No expiry'}</li>
          </ul>
        `;
      }
      
      // Prepare email content
      const mailOptions = {
        from: `"OTC Broker" <${process.env.EMAIL_SMTP_USER}>`,
        to: params.email,
        subject: `OTC Deal: ${deal?.name || params.dealId} - ${partyLabel} Seller`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">OTC Asset Swap Deal Invitation</h2>
            
            <p>You've been invited to participate in an OTC asset swap deal as the <strong>${partyLabel} Seller</strong>.</p>
            
            ${dealDetails}
            
            <p>To proceed with this deal, please click the link below to enter your wallet details:</p>
            
            <div style="margin: 20px 0; padding: 15px; background: #f0f0f0; border-radius: 5px;">
              <a href="${params.link}" style="color: #667eea; word-break: break-all;">
                ${params.link}
              </a>
            </div>
            
            <p style="color: #666; font-size: 12px;">
              <strong>Important:</strong> This link is unique to you. Do not share it with others. 
              The deal will expire after the specified timeout period.
            </p>
            
            <hr style="margin: 20px 0; border: none; border-top: 1px solid #ddd;">
            
            <p style="color: #999; font-size: 11px;">
              This email was sent by the OTC Broker system. 
              If you did not expect this invitation, please ignore this email.
            </p>
          </div>
        `
      };
      
      // Send email
      const info = await this.transporter.sendMail(mailOptions);
      
      console.log(`Email sent successfully to ${params.email} (Message ID: ${info.messageId})`);
      
      return { 
        sent: true, 
        email: params.email,
        message: `Invitation sent to ${params.email}`,
        messageId: info.messageId
      };
      
    } catch (error: any) {
      console.error('Failed to send email:', error);
      return { 
        sent: false, 
        message: `Failed to send email: ${error.message}`,
        email: params.email 
      };
    }
  }
}