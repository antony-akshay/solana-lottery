// tests/lottery.ts
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
} from "@switchboard-xyz/on-demand";
import { Lottery } from "../target/types/lottery";

// Metaplex Token Metadata program (standard)
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// Helpers for Metaplex PDAs
function getMetadataPDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}
function getMasterEditionPDA(mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
      Buffer.from("edition"),
    ],
    TOKEN_METADATA_PROGRAM_ID
  )[0];
}

// Associated Token Account PDA (owner, token program, mint) -> associated token program
function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey) {
  return PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID
  )[0];
}

// Program PDAs that match your Rust seeds
function getTokenLotteryPDA(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("token_lottery")], programId)[0];
}
function getCollectionMintPDA(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("collection_mint")], programId)[0];
}
function getCollectionTokenAccountPDA(programId: PublicKey) {
  return PublicKey.findProgramAddressSync([Buffer.from("collection_associated_token")], programId)[0];
}

describe("lottery (multi-user buy)", () => {
  // Anchor provider
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.lottery as Program<Lottery>;
  const admin = provider.wallet as anchor.Wallet;

  const NUM_USERS = 5; // change as needed
  const users: anchor.web3.Keypair[] = [];

  async function createUsersAndAirdrop() {
    for (let i = 0; i < NUM_USERS; i++) {
      const k = anchor.web3.Keypair.generate();
      users.push(k);
      const sig = await provider.connection.requestAirdrop(k.publicKey, 2 * anchor.web3.LAMPORTS_PER_SOL);
      await provider.connection.confirmTransaction(sig);
      console.log(`Airdropped user ${i}: ${k.publicKey.toBase58()}`);
    }
  }

  it("initialize and multiple users buy tickets", async () => {
    // 1) derive PDAs
    const tokenLotteryPda = getTokenLotteryPDA(program.programId);
    const collectionMintPda = getCollectionMintPDA(program.programId);
    const collectionTokenAccountPda = getCollectionTokenAccountPDA(program.programId);

    console.log("tokenLotteryPda:", tokenLotteryPda.toBase58());
    console.log("collectionMintPda:", collectionMintPda.toBase58());
    console.log("collectionTokenAccountPda:", collectionTokenAccountPda.toBase58());

    // 2) initialize_config (creates token_lottery account)
    {
      // start = 0 (open immediately), end = large slot, price = 10000 lamports (your Rust expects u64)
      const tx = await program.methods
        .initializeConfig(new anchor.BN(0), new anchor.BN(1722712025), new anchor.BN(10000))
        .accounts({
          payer: admin.publicKey,
          tokenLottery: tokenLotteryPda,
          systemProgram: SystemProgram.programId,
        })
        .signers([])
        .rpc();
      console.log("initializeConfig tx:", tx);
    }

    // 3) initialize_lottery (create collection mint & token account and metadata)
    {
      // derive collection metadata & edition PDAs (metaplex)
      const collectionMetadataPda = getMetadataPDA(collectionMintPda);
      const collectionMasterEditionPda = getMasterEditionPDA(collectionMintPda);

      const tx = await program.methods
        .initializeLottery()
        .accounts({
          payer: admin.publicKey,
          collectionMint: collectionMintPda,
          collectionTokenAccount: collectionTokenAccountPda,
          metadata: collectionMetadataPda,
          masterEdition: collectionMasterEditionPda,
          tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
          associatedTokenProgram: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .signers([])
        .rpc();
      console.log("initializeLottery tx:", tx);
    }

    // 4) create users and airdrop
    await createUsersAndAirdrop();

    // 5) For each user: fetch token_lottery to get current total_tickets, derive ticket PDAs, call buyTicket
    for (let i = 0; i < users.length; i++) {
      const user = users[i];

      // fetch token_lottery on-chain to get total_tickets (BN)
      const tokenLottery = await program.account.tokenLottery.fetch(tokenLotteryPda);
      const totalTicketsBN = tokenLottery.totalTickets as any; // Anchor returns BN
      const totalTickets = (totalTicketsBN as anchor.BN).toNumber();

      // derive ticket_mint PDA using the seed token_lottery.total_tickets.to_le_bytes()
      const seedBuf = Buffer.alloc(8);
      seedBuf.writeBigUInt64LE(BigInt(totalTickets), 0);
      const [ticketMintPda] = PublicKey.findProgramAddressSync([seedBuf], program.programId);

      // derive ticket metadata & edition PDAs (metaplex)
      const ticketMetadataPda = getMetadataPDA(ticketMintPda);
      const ticketMasterEditionPda = getMasterEditionPDA(ticketMintPda);

      // collection metadata/edition PDAs (already derived for collection mint)
      const collectionMetadataPda = getMetadataPDA(collectionMintPda);
      const collectionMasterEditionPda = getMasterEditionPDA(collectionMintPda);

      // destination associated token account for buyer to receive the minted ticket
      const destinationAta = getAssociatedTokenAddressSync(ticketMintPda, user.publicKey);

      console.log(`User ${i} buying ticket #${totalTickets}`);
      console.log("ticketMintPda:", ticketMintPda.toBase58());
      console.log("ticketMetadataPda:", ticketMetadataPda.toBase58());
      console.log("destinationAta:", destinationAta.toBase58());

      // Build instruction
      const buyIx = await program.methods
        .buyTicket()
        .accounts({
          payer: user.publicKey,
          tokenLottery: tokenLotteryPda,
          ticketMint: ticketMintPda,
          collectionMint: collectionMintPda,
          ticketMetadata: ticketMetadataPda,
          ticketMasterEdition: ticketMasterEditionPda,
          destination: destinationAta,
          collectionMetadata: collectionMetadataPda,
          collectionMasterEdition: collectionMasterEditionPda,
          tokenMetadataProgram: TOKEN_METADATA_PROGRAM_ID,
          associatedTokenProgram: SPL_ASSOCIATED_TOKEN_ACCOUNT_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          tokenProgram: TOKEN_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .instruction();

      // add compute budget instructions if desired
      const computeIx = anchor.web3.ComputeBudgetProgram.setComputeUnitLimit({ units: 300000 });
      const priorityIx = anchor.web3.ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1 });

      // prepare tx signed by buyer (the buyer is payer in your Rust BuyTicket)
      const blockhashWithContext = await provider.connection.getLatestBlockhash();
      const tx = new anchor.web3.Transaction({
        feePayer: user.publicKey,
        blockhash: blockhashWithContext.blockhash,
        lastValidBlockHeight: blockhashWithContext.lastValidBlockHeight,
      }).add(buyIx).add(computeIx).add(priorityIx);

      // send tx, signed by buyer (user). NOTE: admin is NOT signing here.
      const sig = await anchor.web3.sendAndConfirmTransaction(
        provider.connection,
        tx,
        [user],
        { skipPreflight: true }
      );

      console.log(`User ${i} buyTicket sig:`, sig);
    }

    // final read
    const finalLottery = await program.account.tokenLottery.fetch(tokenLotteryPda);
    console.log("final total_tickets:", finalLottery.totalTickets.toString());
  },);
});
