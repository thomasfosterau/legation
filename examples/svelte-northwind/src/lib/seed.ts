/**
 * Seed data
 *
 * A representative slice of the classic Northwind dataset — enough categories,
 * suppliers, products, customers, employees and orders to exercise the joins,
 * filtering and pagination, without transcribing all 77 products.
 */
import type {
  Category,
  Customer,
  Employee,
  Order,
  OrderDetail,
  Product,
  Supplier,
} from "./domain";
import { orderDetailId } from "./domain";

export const categories: ReadonlyArray<Category> = [
  { id: "1", name: "Beverages", description: "Soft drinks, coffees, teas, beers, and ales" },
  { id: "2", name: "Condiments", description: "Sweet and savory sauces, relishes, spreads, and seasonings" },
  { id: "3", name: "Confections", description: "Desserts, candies, and sweet breads" },
  { id: "4", name: "Dairy Products", description: "Cheeses" },
  { id: "5", name: "Grains/Cereals", description: "Breads, crackers, pasta, and cereal" },
  { id: "6", name: "Meat/Poultry", description: "Prepared meats" },
  { id: "7", name: "Produce", description: "Dried fruit and bean curd" },
  { id: "8", name: "Seafood", description: "Seaweed and fish" },
];

export const suppliers: ReadonlyArray<Supplier> = [
  { id: "1", company: "Exotic Liquids", contact: "Charlotte Cooper", country: "UK" },
  { id: "2", company: "New Orleans Cajun Delights", contact: "Shelley Burke", country: "USA" },
  { id: "3", company: "Grandma Kelly's Homestead", contact: "Regina Murphy", country: "USA" },
  { id: "4", company: "Tokyo Traders", contact: "Yoshi Nagase", country: "Japan" },
  { id: "5", company: "Cooperativa de Quesos", contact: "Antonio del Valle", country: "Spain" },
  { id: "6", company: "Mayumi's", contact: "Mayumi Ohno", country: "Japan" },
];

export const products: ReadonlyArray<Product> = [
  { id: "1", name: "Chai", categoryId: "1", supplierId: "1", unitPrice: 18, unitsInStock: 39, discontinued: false },
  { id: "2", name: "Chang", categoryId: "1", supplierId: "1", unitPrice: 19, unitsInStock: 17, discontinued: false },
  { id: "3", name: "Aniseed Syrup", categoryId: "2", supplierId: "1", unitPrice: 10, unitsInStock: 13, discontinued: false },
  { id: "4", name: "Chef Anton's Cajun Seasoning", categoryId: "2", supplierId: "2", unitPrice: 22, unitsInStock: 53, discontinued: false },
  { id: "5", name: "Chef Anton's Gumbo Mix", categoryId: "2", supplierId: "2", unitPrice: 21.35, unitsInStock: 0, discontinued: true },
  { id: "6", name: "Grandma's Boysenberry Spread", categoryId: "2", supplierId: "3", unitPrice: 25, unitsInStock: 120, discontinued: false },
  { id: "7", name: "Uncle Bob's Organic Dried Pears", categoryId: "7", supplierId: "3", unitPrice: 30, unitsInStock: 15, discontinued: false },
  { id: "8", name: "Northwoods Cranberry Sauce", categoryId: "2", supplierId: "3", unitPrice: 40, unitsInStock: 6, discontinued: false },
  { id: "9", name: "Mishi Kobe Niku", categoryId: "6", supplierId: "4", unitPrice: 97, unitsInStock: 29, discontinued: true },
  { id: "10", name: "Ikura", categoryId: "8", supplierId: "4", unitPrice: 31, unitsInStock: 31, discontinued: false },
  { id: "11", name: "Queso Cabrales", categoryId: "4", supplierId: "5", unitPrice: 21, unitsInStock: 22, discontinued: false },
  { id: "12", name: "Queso Manchego La Pastora", categoryId: "4", supplierId: "5", unitPrice: 38, unitsInStock: 86, discontinued: false },
  { id: "13", name: "Konbu", categoryId: "8", supplierId: "6", unitPrice: 6, unitsInStock: 24, discontinued: false },
  { id: "14", name: "Tofu", categoryId: "7", supplierId: "6", unitPrice: 23.25, unitsInStock: 35, discontinued: false },
  { id: "15", name: "Genen Shouyu", categoryId: "2", supplierId: "6", unitPrice: 15.5, unitsInStock: 39, discontinued: false },
  { id: "16", name: "Pavlova", categoryId: "3", supplierId: "3", unitPrice: 17.45, unitsInStock: 29, discontinued: false },
  { id: "17", name: "Alice Mutton", categoryId: "6", supplierId: "4", unitPrice: 39, unitsInStock: 0, discontinued: true },
  { id: "18", name: "Carnarvon Tigers", categoryId: "8", supplierId: "4", unitPrice: 62.5, unitsInStock: 42, discontinued: false },
  { id: "19", name: "Teatime Chocolate Biscuits", categoryId: "3", supplierId: "1", unitPrice: 9.2, unitsInStock: 25, discontinued: false },
  { id: "20", name: "Sir Rodney's Marmalade", categoryId: "3", supplierId: "3", unitPrice: 81, unitsInStock: 40, discontinued: false },
  { id: "21", name: "Gravad lax", categoryId: "8", supplierId: "6", unitPrice: 26, unitsInStock: 5, discontinued: false },
  { id: "22", name: "Gnocchi di nonna Alice", categoryId: "5", supplierId: "5", unitPrice: 38, unitsInStock: 21, discontinued: false },
  { id: "23", name: "Ravioli Angelo", categoryId: "5", supplierId: "5", unitPrice: 19.5, unitsInStock: 36, discontinued: false },
  { id: "24", name: "Outback Lager", categoryId: "1", supplierId: "2", unitPrice: 15, unitsInStock: 15, discontinued: false },
];

export const customers: ReadonlyArray<Customer> = [
  { id: "ALFKI", company: "Alfreds Futterkiste", contact: "Maria Anders", country: "Germany" },
  { id: "ANATR", company: "Ana Trujillo Emparedados", contact: "Ana Trujillo", country: "Mexico" },
  { id: "AROUT", company: "Around the Horn", contact: "Thomas Hardy", country: "UK" },
  { id: "BERGS", company: "Berglunds snabbköp", contact: "Christina Berglund", country: "Sweden" },
  { id: "BLAUS", company: "Blauer See Delikatessen", contact: "Hanna Moos", country: "Germany" },
  { id: "BONAP", company: "Bon app'", contact: "Laurence Lebihan", country: "France" },
];

export const employees: ReadonlyArray<Employee> = [
  { id: "1", firstName: "Nancy", lastName: "Davolio", title: "Sales Representative" },
  { id: "2", firstName: "Andrew", lastName: "Fuller", title: "VP, Sales" },
  { id: "3", firstName: "Janet", lastName: "Leverling", title: "Sales Representative" },
  { id: "4", firstName: "Margaret", lastName: "Peacock", title: "Sales Representative" },
];

const day = 24 * 60 * 60 * 1000;
const base = Date.UTC(1997, 0, 1);

export const orders: ReadonlyArray<Order> = [
  { id: "10643", customerId: "ALFKI", employeeId: "1", orderedAt: base + 0 * day, shippedAt: base + 4 * day, shipCountry: "Germany" },
  { id: "10692", customerId: "ALFKI", employeeId: "4", orderedAt: base + 30 * day, shippedAt: null, shipCountry: "Germany" },
  { id: "10308", customerId: "ANATR", employeeId: "3", orderedAt: base + 2 * day, shippedAt: base + 6 * day, shipCountry: "Mexico" },
  { id: "10355", customerId: "AROUT", employeeId: "2", orderedAt: base + 10 * day, shippedAt: base + 13 * day, shipCountry: "UK" },
  { id: "10383", customerId: "AROUT", employeeId: "4", orderedAt: base + 20 * day, shippedAt: null, shipCountry: "UK" },
  { id: "10278", customerId: "BERGS", employeeId: "1", orderedAt: base + 5 * day, shippedAt: base + 9 * day, shipCountry: "Sweden" },
  { id: "10501", customerId: "BLAUS", employeeId: "3", orderedAt: base + 40 * day, shippedAt: null, shipCountry: "Germany" },
  { id: "10331", customerId: "BONAP", employeeId: "2", orderedAt: base + 8 * day, shippedAt: base + 11 * day, shipCountry: "France" },
];

const detail = (orderId: string, productId: string, unitPrice: number, quantity: number, discount = 0): OrderDetail => ({
  id: orderDetailId(orderId, productId),
  orderId,
  productId,
  unitPrice,
  quantity,
  discount,
});

export const orderDetails: ReadonlyArray<OrderDetail> = [
  detail("10643", "1", 18, 15, 0.05),
  detail("10643", "2", 19, 21),
  detail("10692", "6", 25, 20),
  detail("10308", "13", 6, 5),
  detail("10308", "14", 23.25, 1),
  detail("10355", "18", 62.5, 25),
  detail("10355", "20", 81, 6),
  detail("10383", "11", 21, 15),
  detail("10278", "10", 31, 10, 0.1),
  detail("10278", "16", 17.45, 12),
  detail("10501", "22", 38, 20),
  detail("10331", "12", 38, 8),
  detail("10331", "23", 19.5, 10),
];
