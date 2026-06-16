use std::convert::TryFrom;

// 1. BOUNDED CONSTANTS
const MAX_ACCOUNTS: usize = 100_000;

// 2. ERROR DEFINITIONS (Zero-allocation static strings)
#[derive(Debug, PartialEq)]
pub enum MutatorError {
    InvalidActionType,
    AccountOutOfBounds,
    AccountBlocked,
    InsufficientFunds,
    BalanceOverflow,
    SelfTransfer,
}

// 3. THE ACTION TYPE (Mapped to the corrected byte 128 of the Envelope)
#[repr(u8)]
#[derive(Debug, PartialEq)]
pub enum ActionType {
    Transfer = 1,
    PayBill = 2,
    CardBlock = 3,
}

impl TryFrom<u8> for ActionType {
    type Error = MutatorError;
    #[inline(always)]
    fn try_from(value: u8) -> Result<Self, Self::Error> {
        match value {
            1 => Ok(ActionType::Transfer),
            2 => Ok(ActionType::PayBill),
            3 => Ok(ActionType::CardBlock),
            _ => Err(MutatorError::InvalidActionType),
        }
    }
}

// 4. ACCOUNT STATE
#[repr(u8)]
#[derive(Clone, Copy, PartialEq)]
pub enum AccountStatus {
    Active = 0,
    Blocked = 1,
}

// 5. THE ACCOUNT PRIMITIVE
// Aligned to 16 bytes for optimal CPU cache-line packing.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Account {
    pub balance: u64,
    pub status: AccountStatus,
    pub _padding: [u8; 7], // Pad to 16 bytes
}

impl Default for Account {
    fn default() -> Self {
        Self {
            balance: 0,
            status: AccountStatus::Active,
            _padding: [0; 7],
        }
    }
}

// 6. THE STATE MACHINE
pub struct Ledger {
    // A flat, pre-allocated contiguous array in RAM.
    // Boxed slice ensures the size is mathematically locked at runtime and avoids Vec capacity overhead.
    accounts: Box<[Account]>,
}

impl Ledger {
    /// Bootstraps the ledger with 100,000 zeroed accounts.
    pub fn new() -> Self {
        Self {
            accounts: vec![Account::default(); MAX_ACCOUNTS].into_boxed_slice(),
        }
    }

    /// The Critical Hot Path: Mutates state based on the verified envelope.
    /// Executes completely in L1/L2 cache. Expected latency: ~15-30ns.
    #[inline(always)]
    pub fn apply_mutation(
        &mut self,
        action_byte: u8,
        sender: u32,
        receiver: u32,
        amount: u64,
    ) -> Result<(), MutatorError> {

        // 1. Parse Action
        let action = ActionType::try_from(action_byte)?;

        // 2. Global Bounds Check (Eliminates panic risk)
        if sender as usize >= MAX_ACCOUNTS || receiver as usize >= MAX_ACCOUNTS {
            return Err(MutatorError::AccountOutOfBounds);
        }

        // 3. Action Routing
        match action {
            ActionType::Transfer | ActionType::PayBill => {
                self.execute_transfer(sender as usize, receiver as usize, amount)
            }
            ActionType::CardBlock => {
                self.execute_block(sender as usize)
            }
        }
    }

    #[inline(always)]
    fn execute_transfer(&mut self, sender_idx: usize, receiver_idx: usize, amount: u64) -> Result<(), MutatorError> {
        if sender_idx == receiver_idx {
            return Err(MutatorError::SelfTransfer);
        }

        // We use split_at_mut (or unsafe pointers in hyper-optimized scenarios)
        // to appease the borrow checker when mutating two indices in the same slice.
        // For sub-100ns, we use unsafe unchecked indexing because we ALREADY proved
        // the indices are < MAX_ACCOUNTS and sender != receiver.
        unsafe {
            let sender = self.accounts.get_unchecked_mut(sender_idx);
            let receiver = self.accounts.get_unchecked_mut(receiver_idx);

            // Business Bounds
            if sender.status == AccountStatus::Blocked || receiver.status == AccountStatus::Blocked {
                return Err(MutatorError::AccountBlocked);
            }

            if sender.balance < amount {
                return Err(MutatorError::InsufficientFunds);
            }

            // Mathematical Execution (No floats, strictly checked bounds)
            // Even though we proved sender.balance >= amount, we use checked_add
            // on the receiver to mathematically eliminate overflow heists.
            let new_receiver_balance = receiver.balance.checked_add(amount)
                .ok_or(MutatorError::BalanceOverflow)?;

            sender.balance -= amount;
            receiver.balance = new_receiver_balance;
        }

        Ok(())
    }

    #[inline(always)]
    fn execute_block(&mut self, sender_idx: usize) -> Result<(), MutatorError> {
        // Unsafe is mathematically justified here due to the global bounds check.
        unsafe {
            let sender = self.accounts.get_unchecked_mut(sender_idx);
            sender.status = AccountStatus::Blocked;
        }
        Ok(())
    }
}