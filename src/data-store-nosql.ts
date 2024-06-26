import { DataStore, DataStream, DataStoreGetResult, DataStorePutResult } from '@tbd54566975/dwn-sdk-js';
import { Kysely } from 'kysely';
import { Readable } from 'readable-stream';
import { DwnDatabaseType } from './types.js';
import { Dialect } from './dialect/dialect.js';
import { 
  DynamoDBClient,
  ListTablesCommand,
  CreateTableCommand,
  AttributeDefinition,
  KeySchemaElement,
  BillingMode,
  TableClass,
  GetItemCommand,
  PutItemCommand,
  ScanCommand,
  DeleteItemCommand,
  ScanCommandInput,
  ScanCommandOutput
} from '@aws-sdk/client-dynamodb';
import {
  marshall
} from '@aws-sdk/util-dynamodb'

export class DataStoreNoSql implements DataStore {
  #dialect: Dialect;
  #db: Kysely<DwnDatabaseType> | null = null;

  #client: DynamoDBClient;

  constructor(dialect: Dialect) {
    this.#dialect = dialect;
    this.#client = new DynamoDBClient({
      region: 'localhost',
      endpoint: 'http://0.0.0.0:8006',
      credentials: {
        accessKeyId: 'MockAccessKeyId',
        secretAccessKey: 'MockSecretAccessKey'
      },
    });
  }

  async open(): Promise<void> {

    console.log("Created client");

    const input = { // ListTablesInput
      Limit: Number("1"),
    };
    const command = new ListTablesCommand(input);
    const response = await this.#client.send(command);
    console.log(response);

    // Does table already exist?
    if ( response.TableNames ) {
      console.log("Found Table Names in response");

      const tableExists = response.TableNames?.length > 0 && response.TableNames?.indexOf("dataStore") !== -1
      if ( tableExists ) {
        console.log("TABLE ALREADY EXISTS");
        return;
      }
    }

    console.log("Trying to create table");

    const createTableInput = { // CreateTableInput
      AttributeDefinitions: [ // AttributeDefinitions // required
        { // AttributeDefinition
          AttributeName: "tenant", // required
          AttributeType: "S", // required
        } as AttributeDefinition,
        { // AttributeDefinition
          AttributeName: "recordIdDataCid", // required
          AttributeType: "S", // required
        } as AttributeDefinition
      ],
      TableName: "dataStore", // required
      KeySchema: [ // KeySchema // required
        { // KeySchemaElement
          AttributeName: "tenant", // required
          KeyType: "HASH", // required
        } as KeySchemaElement,
        { // KeySchemaElement
          AttributeName: "recordIdDataCid", // required
          KeyType: "RANGE", // required
        } as KeySchemaElement,
      ],
      BillingMode: "PAY_PER_REQUEST" as BillingMode,
      TableClass: "STANDARD" as TableClass,
    };

    console.log("Create Table command");
    const createTableCommand = new CreateTableCommand(createTableInput);

    console.log("Send table command");
    try {
      const createTableResponse = await this.#client.send(createTableCommand);
      console.log(createTableResponse);
    } catch ( error ) {
      console.error(error);
    }
  }

  async close(): Promise<void> {
    // await this.#db?.destroy();
    // this.#db = null;
    this.#client.destroy();
  }

  async get(
    tenant: string,
    recordId: string,
    dataCid: string
  ): Promise<DataStoreGetResult | undefined> {
    if (!this.#client) {
      throw new Error(
        'Connection to database not open. Call `open` before using `get`.'
      );
    }

    const input = { // GetItemInput
      TableName: "dataStore", // required
      Key: { // Key // required
        "tenant": { // AttributeValue Union: only one key present
          S: tenant,
        },
        "recordIdDataCid": {
          S: recordId + "|" + dataCid
        }
      },
      AttributesToGet: [ // AttributeNameList
        "tenant", "recordId", "dataCid", "data"
      ]
    };
    const command = new GetItemCommand(input);
    const response = await this.#client.send(command);
    response.Item

    if ( !response.Item ) {
      return undefined;
    }

    const result = {
        recordId: response.Item.recordId.S?.toString(),
        tenant: response.Item.tenant.S?.toString(),
        dataCid: response.Item.dataCid.S?.toString(),
        data: response.Item.data.B
    }

    return {
      dataSize   : result.data ? result.data.length : 0,
      dataStream : new Readable({
        read() {
          this.push(result.data ? Buffer.from(result.data) : null);
          this.push(null);
        }
      }),
    };
  }

  async put(
    tenant: string,
    recordId: string,
    dataCid: string,
    dataStream: Readable
  ): Promise<DataStorePutResult> {

    const bytes = await DataStream.toBytes(dataStream);
    const data = Buffer.from(bytes);

    const input = {
      "Item": {
        "tenant": {
          "S": tenant
        },
        "recordId": {
          "S": recordId
        },
        "dataCid": {
          "S": dataCid
        },
        "recordIdDataCid": {
          "S": recordId + "|" + dataCid
        },
        "data": {
          "B": data
        }
      },
      "TableName": "dataStore"
    };
    const command = new PutItemCommand(input);
    await this.#client.send(command);

    return {
      dataSize: bytes.length
    };
  }

  async delete(
    tenant: string,
    recordId: string,
    dataCid: string
  ): Promise<void> {
    if (!this.#client) {
      throw new Error(
        'Connection to database not open. Call `open` before using `delete`.'
      );
    }

    let deleteParams = {
      TableName: "dataStore",
      Key: marshall({
          'tenant': tenant, // Adjust 'primaryKey' based on your table's partition key
          'recordIdDataCid': recordId + "|" + dataCid
      })
    };
    
    let deleteCommand = new DeleteItemCommand(deleteParams);
    await this.#client.send(deleteCommand);
  }

  async clear(): Promise<void> {
    if (!this.#client) {
      throw new Error(
        'Connection to database not open. Call `open` before using `clear`.'
      );
    }

    try {
      let scanParams: ScanCommandInput = {
          TableName: "dataStore"
      };

      let scanCommand = new ScanCommand(scanParams);
      let scanResult;
      
      do {
          scanResult = await this.#client.send(scanCommand);

          // Delete each item
          for (let item of scanResult.Items) {
              let deleteParams = {
                  TableName: "dataStore",
                  Key: marshall({
                      'tenant': item.tenant.S.toString(), // Adjust 'primaryKey' based on your table's partition key
                      'recordIdDataCid': item.recordIdDataCid.S.toString()
                  })
              };
              
              let deleteCommand = new DeleteItemCommand(deleteParams);
              await this.#client.send(deleteCommand);
              console.log("Deleted item successfully");
          }

          // Continue scanning if we have more items
          scanParams.ExclusiveStartKey = scanResult.LastEvaluatedKey;

      } while (scanResult.LastEvaluatedKey);

      console.log(`Successfully cleared all data from "dataStore"`);
    } catch (err) {
        console.error('Unable to clear table:', err);
    }
  }

}