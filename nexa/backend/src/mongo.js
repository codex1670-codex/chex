
import { MongoClient } from 'mongodb';

let client;
let database;

export async function connectMongo() {
  const uri = process.env.MONGODB_URI;
  const dbName = process.env.MONGODB_DB_NAME || 'nexa';

  if (!uri) {
    throw new Error('MONGODB_URI environment variable is missing');
  }

  if (!client) {
    client = new MongoClient(uri);
    await client.connect();
    database = client.db(dbName);
    await database.command({ ping: 1 });
    console.log(`MongoDB connected: ${dbName}`);
  }

  return database;
}

export async function closeMongo() {
  if (client) {
    await client.close();
    client = undefined;
    database = undefined;
  }
}
