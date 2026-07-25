import { buildSchema } from "graphql";

export const schema = buildSchema(`
  type User {
    address: String!
    kycVerified: Boolean!
    createdAt: String!
  }

  type Epoch {
    epoch: Int!
    yieldAmount: String!
    totalShares: String!
    yieldPerShare: String!
    distributedAt: String
  }

  type ApiKey {
    id: ID!
    label: String
    role: String!
    createdAt: String!
  }

  type Query {
    user(address: String!): User
    epochs(contractId: String!): [Epoch!]!
    apiKeys: [ApiKey!]!
  }
`);
