export interface CatalogItem {
  id: string;
  name: string;
  price_paise: number;
  stock: number;
}

export interface QuoteItem {
  product_id: string;
  qty: number;
  price_paise: number;
  hold_token: string;
}

export interface Quote {
  quote_id: string;
  items: QuoteItem[];
  total_paise: number;
  valid_until: string;
  hold_token: string;
  audit_seq: number;
}

export interface PurchaseIntent {
  order_id: string;
  payment_url: string;
  amount_paise: number;
  ttl_seconds: number;
  audit_seq: number;
}

export interface PaymentStatus {
  status: string;
  audit_seq: number;
  failure_receipt?: { reason_code: string; error_description: string };
  retry_url?: string;
}

export interface DiscoveryDoc {
  merchant_name: string;
  catalog_url: string;
  quote_url: string;
  purchase_intent_url: string;
  payment_status_url: string;
  payment_methods: string[];
  currency: string;
  policies: {
    max_auto_amount_paise: number;
    escalation_threshold_paise: number;
    hold_ttl_minutes: number;
    max_retries: number;
  };
}

export class SellableBuyer {
  private merchantUrl: string;
  private apiKey: string;

  constructor(merchantUrl: string, apiKey: string) {
    this.merchantUrl = merchantUrl.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  private async request(path: string, options: RequestInit = {}): Promise<any> {
    const res = await fetch(`${this.merchantUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "Idempotency-Key": crypto.randomUUID(),
        ...options.headers,
      },
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(`HTTP ${res.status}: ${body.detail || res.statusText}`);
    }

    return res.json();
  }

  async discover(): Promise<DiscoveryDoc> {
    const res = await fetch(`${this.merchantUrl}/.well-known/agent-commerce.json`);
    return res.json();
  }

  async catalog(): Promise<CatalogItem[]> {
    return this.request("/agent/catalog");
  }

  async quote(items: { id: string; qty: number }[], budgetPaise?: number): Promise<Quote> {
    return this.request("/agent/quote", {
      method: "POST",
      body: JSON.stringify({ items, budget_paise: budgetPaise }),
    });
  }

  async purchaseIntent(
    quoteId: string,
    holdToken: string,
    paymentMethodHint?: string
  ): Promise<PurchaseIntent> {
    return this.request("/agent/purchase-intent", {
      method: "POST",
      body: JSON.stringify({
        quote_id: quoteId,
        hold_token: holdToken,
        payment_method_hint: paymentMethodHint,
      }),
    });
  }

  async paymentStatus(orderId: string): Promise<PaymentStatus> {
    return this.request(`/agent/payment-status?order_id=${orderId}`);
  }
}
