import { Deal, DealStage, EscrowDeposit } from './types';
import { isAmountGte, sumAmounts, subtractAmounts } from './decimal';

export interface LockEligibility {
  tradeLocked: boolean;
  commissionLocked: boolean;
  eligibleDeposits: EscrowDeposit[];
  tradeCollected: string;
  commissionCollected: string;
}

export function validateDealTransition(
  currentStage: DealStage,
  newStage: DealStage,
): boolean {
  const validTransitions: Record<DealStage, DealStage[]> = {
    'CREATED': ['COLLECTION'],
    'COLLECTION': ['WAITING', 'REVERTED'],
    'WAITING': ['SWAP', 'COLLECTION'],  // Can go to SWAP or back to COLLECTION (reorg)
    'SWAP': ['CLOSED', 'COLLECTION'],    // Can complete or revert to COLLECTION (reorg)
    'REVERTED': ['CLOSED'],              // After refunds complete
    'CLOSED': [],
  };
  
  return validTransitions[currentStage].includes(newStage);
}

export function computeEligibleDeposits(
  deposits: EscrowDeposit[],
  minConfirms: number,
  expiresAt: string,
): EscrowDeposit[] {
  const expiryTime = new Date(expiresAt).getTime();
  
  return deposits.filter(deposit => {
    // Must have enough confirmations
    if (deposit.confirms < minConfirms) return false;
    
    // Must have blockTime <= expiresAt
    if (deposit.blockTime) {
      const blockTime = new Date(deposit.blockTime).getTime();
      if (blockTime > expiryTime) return false;
    }
    
    return true;
  });
}

export function checkLocks(
  deposits: EscrowDeposit[],
  tradeAsset: string,
  tradeAmount: string,
  commissionAsset: string,
  commissionAmount: string,
  minConfirms: number,
  expiresAt: string,
): LockEligibility {
  const eligible = computeEligibleDeposits(deposits, minConfirms, expiresAt);
  
  // Sum by asset
  const tradeDeposits = eligible.filter(d => d.asset === tradeAsset);
  const commissionDeposits = eligible.filter(d => d.asset === commissionAsset);
  
  const tradeCollected = sumAmounts(tradeDeposits.map(d => d.amount));
  const commissionCollected = sumAmounts(commissionDeposits.map(d => d.amount));
  
  // Check if locks are satisfied
  const tradeLocked = isAmountGte(tradeCollected, tradeAmount);
  
  // Commission lock depends on whether commission is in same asset or different
  let commissionLocked = false;
  if (commissionAsset === tradeAsset) {
    // Commission comes from surplus of trade asset
    const totalNeeded = sumAmounts([tradeAmount, commissionAmount]);
    commissionLocked = isAmountGte(tradeCollected, totalNeeded);
  } else {
    // Commission is in different asset (native)
    commissionLocked = isAmountGte(commissionCollected, commissionAmount);
  }
  
  return {
    tradeLocked,
    commissionLocked,
    eligibleDeposits: eligible,
    tradeCollected,
    commissionCollected,
  };
}

export function calculateSurplus(
  collectedAmount: string,
  tradeAmount: string,
  commissionAmount: string,
  isCommissionSameAsset: boolean,
): string {
  if (isCommissionSameAsset) {
    const totalUsed = sumAmounts([tradeAmount, commissionAmount]);
    const surplus = subtractAmounts(collectedAmount, totalUsed);
    return surplus.startsWith('-') ? '0' : surplus;
  } else {
    const surplus = subtractAmounts(collectedAmount, tradeAmount);
    return surplus.startsWith('-') ? '0' : surplus;
  }
}

export function validateDealInvariants(deal: Deal): string[] {
  const errors: string[] = [];
  
  // Check stage consistency
  if (deal.stage === 'COLLECTION' && !deal.expiresAt) {
    errors.push('COLLECTION stage requires expiresAt to be set');
  }
  
  if (deal.stage === 'COLLECTION' && (!deal.aliceDetails || !deal.bobDetails)) {
    errors.push('COLLECTION stage requires both parties to have filled details');
  }
  
  if ((deal.stage === 'WAITING' || deal.stage === 'CLOSED') && 
      (!deal.sideAState?.locks.tradeLockedAt || !deal.sideBState?.locks.tradeLockedAt)) {
    errors.push('WAITING/CLOSED stages require both sides to have trade locks');
  }
  
  // Check commission plan
  if (deal.stage !== 'CREATED' && !deal.commissionPlan.sideA.nativeFixed && 
      deal.commissionPlan.sideA.mode === 'FIXED_USD_NATIVE') {
    errors.push('FIXED_USD_NATIVE commission requires nativeFixed to be set after COUNTDOWN');
  }
  
  return errors;
}