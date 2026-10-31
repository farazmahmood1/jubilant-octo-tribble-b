-- How the customer paid, as Shopify names the payment gateways (Order.paymentGatewayNames): "Cash on
-- Delivery (COD)", a card gateway, or both for an order part-paid in advance. A card order's parcel
-- carries zero COD, and without this the Orders screen cannot say why. Null until the order is next
-- read from the API (or for a consignment sale), so it reads as unknown, never as COD.
alter table orders add column payment_gateways text[];
