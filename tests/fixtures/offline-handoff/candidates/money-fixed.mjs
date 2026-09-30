export function totalCents(orders) {
  return orders.reduce((sum, order) => sum + order.unitPriceCents * order.quantity, 0);
}
