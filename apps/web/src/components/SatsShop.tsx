import React, { useState } from "react";

interface Product {
  id: string;
  name: string;
  category: string;
  priceSats: number;
  description: string;
  imageIcon: string;
}

const PRODUCTS: Product[] = [
  {
    id: "prod-node",
    name: "Sovereign Bitcoin Node v2",
    category: "Hardware",
    priceSats: 150000,
    description: "Plug-and-play Bitcoin full node with integrated Tachi VTXO validator sync.",
    imageIcon: "🖥️",
  },
  {
    id: "prod-signer",
    name: "Tachi Taproot Hardware Signer",
    category: "Security",
    priceSats: 80000,
    description: "Air-gapped hardware signer with native TAURUS vault Schnorr signature support.",
    imageIcon: "🔐",
  },
  {
    id: "prod-swag",
    name: "OP_Freedom Hackathon Kit",
    category: "Apparel & Swag",
    priceSats: 25000,
    description: "Official Tachi OP_Freedom builder hoodie, NFC satoshi coin, and sticker pack.",
    imageIcon: "⚡",
  },
  {
    id: "prod-plate",
    name: "Titanium Seed Backup Plate",
    category: "Cold Storage",
    priceSats: 40000,
    description: "Fireproof, waterproof titanium plate for 24-word BIP39 seed phrases.",
    imageIcon: "🛡️",
  },
];

interface Props {
  onBuyProduct: (product: Product) => void;
}

export function SatsShop({ onBuyProduct }: Props) {
  const [purchasedIds, setPurchasedIds] = useState<Set<string>>(new Set());

  const handleBuy = (product: Product) => {
    onBuyProduct(product);
  };

  return (
    <div className="sats-shop-container">
      <div className="shop-header">
        <div>
          <h2>SatsShop • Merchant E-Commerce Showcase</h2>
          <p className="shop-subtitle">
            Sample catalog for the <code>@satsloom/ecommerce</code> client. Checkout is simulated; no product is paid for or fulfilled.
          </p>
        </div>
        <div className="integration-badge">
          <span>Powered by @satsloom/ecommerce</span>
        </div>
      </div>

      <div className="products-grid">
        {PRODUCTS.map((prod) => (
          <div key={prod.id} className="product-card">
            <div className="product-icon-wrap">
              <span className="product-icon">{prod.imageIcon}</span>
              <span className="product-category">{prod.category}</span>
            </div>
            <h3>{prod.name}</h3>
            <p className="product-desc">{prod.description}</p>
            <div className="product-footer">
              <div className="product-price">
                <span className="sats-number">{prod.priceSats.toLocaleString()}</span>
                <span className="sats-unit">SATS</span>
              </div>
              <button className="btn-buy-shop" onClick={() => handleBuy(prod)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                </svg>
                <span>Create Demo Checkout</span>
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="checkout-simulation-banner" role="note">
        <div className="banner-info"><strong>Demo catalog:</strong> listed amounts are sample values; no payment is collected and no order is fulfilled.</div>
      </div>

      <div className="ecommerce-code-preview">
        <h4>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--amber)" strokeWidth="2">
            <polyline points="16 18 22 12 16 6" />
            <polyline points="8 6 2 12 8 18" />
          </svg>
          Example Client Usage (Simulation Only)
        </h4>
        <pre>
          <code>{`import { SatsLoomMerchantClient } from "@satsloom/ecommerce";

const satsloom = new SatsLoomMerchantClient("https://your-demo.example");
const checkout = await satsloom.createCheckout({
  orderId: "shop-order-101",
  amountSats: 25000,
  memo: "OP_Freedom Hackathon Kit",
});

// Demo only: no payment is collected and no order can be fulfilled.
console.log({ paymentUrl: checkout.paymentUrl, simulation: checkout.simulation });`}</code>
        </pre>
      </div>
    </div>
  );
}
