import {
  DwnInterfaceName,
  DwnMethodName,
  executeUnlessAborted,
  Filter,
  GenericMessage,
  MessageStore,
  MessageStoreOptions,
  MessageSort,
  Pagination,
  SortDirection,
  PaginationCursor,
} from '@tbd54566975/dwn-sdk-js';

import { Kysely, Transaction } from 'kysely';
import { DwnDatabaseType, KeyValues } from './types.js';
import * as block from 'multiformats/block';
import * as cbor from '@ipld/dag-cbor';
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
  QueryCommand,
  GlobalSecondaryIndex,
  QueryCommandInput
} from '@aws-sdk/client-dynamodb';
import {
  marshall
} from '@aws-sdk/util-dynamodb'
import { executeWithRetryIfDatabaseIsLocked } from './utils/transaction.js';
import { extractTagsAndSanitizeIndexes } from './utils/sanitize.js';
import { filterSelectQuery } from './utils/filter.js';
import { sha256 } from 'multiformats/hashes/sha2';
import { TagTables } from './utils/tags.js';
import { v4 as uuidv4 } from 'uuid';
import Cursor from 'pg-cursor';



export class MessageStoreNoSql implements MessageStore {
  #dialect: Dialect;
  #tags: TagTables;
  #db: Kysely<DwnDatabaseType> | null = null;
  #tableName: string = "messageStoreMessages";
  #tagTableName: string = "messageStoreRecordsTags";
  #client: DynamoDBClient;

  constructor(dialect: Dialect) {
    this.#tags = new TagTables(dialect, 'messageStoreMessages');
    this.#dialect = dialect;
    this.#client = new DynamoDBClient({
      region: 'localhost',
      endpoint: 'http://0.0.0.0:8006',
      credentials: {
        accessKeyId: 'MockAccessKeyId',
        secretAccessKey: 'MockSecretAccessKey'
      },
    });
    // this.#client = new DynamoDBClient({
    //   region: 'us-west-2'
    // });
  }

  async open(): Promise<void> {
    //console.log("Created client");

    const input = { // ListTablesInput
      Limit: Number("1"),
    };
    const command = new ListTablesCommand(input);
    const response = await this.#client.send(command);
    //console.log(response);

    // Does table already exist?
    if ( response.TableNames ) {
      //console.log("Found Table Names in response");

      const tableExists = response.TableNames?.length > 0 && response.TableNames?.indexOf(this.#tableName) !== -1
      if ( tableExists ) {
        //console.log(this.#tableName + " TABLE ALREADY EXISTS");
      } else {
        //console.log("Trying to create table");
        const createTableInput = { // CreateTableInput
          AttributeDefinitions: [ // AttributeDefinitions // required
            { // AttributeDefinition
              AttributeName: "tenant", // required
              AttributeType: "S", // required
            } as AttributeDefinition,
            { // AttributeDefinition
              AttributeName: "messageCid", // required
              AttributeType: "S", // required
            } as AttributeDefinition,
            { // AttributeDefinition
              AttributeName: "dateCreated", // required
              AttributeType: "S", // required
            } as AttributeDefinition,
            { // AttributeDefinition
              AttributeName: "datePublished", // required
              AttributeType: "S", // required
            } as AttributeDefinition,
            { // AttributeDefinition
              AttributeName: "messageTimestamp", // required
              AttributeType: "S", // required
            } as AttributeDefinition
          ],
          TableName: this.#tableName, // required
          KeySchema: [ // KeySchema // required
            { // KeySchemaElement
              AttributeName: "tenant", // required
              KeyType: "HASH", // required
            } as KeySchemaElement,
            { // KeySchemaElement
              AttributeName: "messageCid", // required
              KeyType: "RANGE", // required
            } as KeySchemaElement,
          ],
          GlobalSecondaryIndexes: [
            {
                IndexName: "dateCreated",
                KeySchema: [
                    { AttributeName: "tenant", KeyType: 'HASH' } as KeySchemaElement, // GSI partition key
                    { AttributeName: "dateCreated", KeyType: 'RANGE' } as KeySchemaElement // Optional GSI sort key
                ],
                Projection: {
                    ProjectionType: 'ALL' // Adjust as needed ('ALL', 'KEYS_ONLY', 'INCLUDE')
                }
            } as GlobalSecondaryIndex,
            {
              IndexName: "datePublished",
              KeySchema: [
                  { AttributeName: "tenant", KeyType: 'HASH' } as KeySchemaElement, // GSI partition key
                  { AttributeName: "datePublished", KeyType: 'RANGE' } as KeySchemaElement // Optional GSI sort key
              ],
              Projection: {
                  ProjectionType: 'ALL' // Adjust as needed ('ALL', 'KEYS_ONLY', 'INCLUDE')
              }
            } as GlobalSecondaryIndex,
            {
              IndexName: "messageTimestamp",
              KeySchema: [
                  { AttributeName: "tenant", KeyType: 'HASH' } as KeySchemaElement, // GSI partition key
                  { AttributeName: "messageTimestamp", KeyType: 'RANGE' } as KeySchemaElement // Optional GSI sort key
              ],
              Projection: {
                  ProjectionType: 'ALL' // Adjust as needed ('ALL', 'KEYS_ONLY', 'INCLUDE')
              }
            } as GlobalSecondaryIndex
          ],
          BillingMode: "PAY_PER_REQUEST" as BillingMode,
          TableClass: "STANDARD" as TableClass,
        };

        //console.log("Create Table command");
        const createTableCommand = new CreateTableCommand(createTableInput);

        //console.log("Send table command");
        try {
          const createTableResponse = await this.#client.send(createTableCommand);
          //console.log(createTableResponse);
        } catch ( error ) {
          console.error(error);
        }
      }
    }
  }

  async close(): Promise<void> {
    this.#client.destroy();
  }

  async put(
    tenant: string,
    message: GenericMessage,
    indexes: KeyValues,
    options?: MessageStoreOptions
  ): Promise<void> {
    if (!this.#client) {
      throw new Error(
        'Connection to database not open. Call `open` before using `put`.'
      );
    }

    //console.log(JSON.stringify(message));

    options?.signal?.throwIfAborted();

    // gets the encoded data and removes it from the message
    // we remove it from the message as it would cause the `encodedMessageBytes` to be greater than the
    // maximum bytes allowed by SQL
    const getEncodedData = (message: GenericMessage): { message: GenericMessage, encodedData: string|null} => {
      let encodedData: string|null = null;
      if (message.descriptor.interface === DwnInterfaceName.Records && message.descriptor.method === DwnMethodName.Write) {
        const data = (message as any).encodedData as string|undefined;
        if(data) {
          delete (message as any).encodedData;
          encodedData = data;
          //console.log("ENCODED DATA");
          //console.log(encodedData);
        }
      }
      return { message, encodedData };
    };

    const { message: messageToProcess, encodedData} = getEncodedData(message);

    const encodedMessageBlock = await executeUnlessAborted(
      block.encode({ value: messageToProcess, codec: cbor, hasher: sha256}),
      options?.signal
    );

    const messageCid = encodedMessageBlock.cid.toString();
    const encodedMessageBytes = Buffer.from(encodedMessageBlock.bytes);

    // In SQL this is split into an insert into a tags table and the message table.
    // Since we're working with docs here, there should be no reason why we can't
    // put it in one write.
    const { indexes: putIndexes, tags } = extractTagsAndSanitizeIndexes(indexes);
    const input = {
      "Item": {
        "tenant": {
          "S": tenant
        },
        "messageCid": {
          "S": messageCid
        },
        "encodedMessageBytes": {
          "B": encodedMessageBytes
        },
        ...tags,
        ...putIndexes
      },
      "TableName": this.#tableName
    };

    if ( encodedData !== null ) {
      input.Item["encodedData"] = {
        "S": encodedData
      }
    } 

    //console.log("PUT:");
    //console.log(input);
    const command = new PutItemCommand(input);
    try {
      await this.#client.send(command);
    } catch ( error ) {
      //console.log("FAILED");
      //console.error(error);
    }
    
  }

  async get(
    tenant: string,
    cid: string,
    options?: MessageStoreOptions
  ): Promise<GenericMessage | undefined> {
    if (!this.#client) {
      throw new Error(
        'Connection to database not open. Call `open` before using `get`.'
      );
    }
    try {
      //console.log("GET");
      options?.signal?.throwIfAborted();

      const input = { // GetItemInput
        TableName: this.#tableName, // required
        Key: { // Key // required
          "tenant": { // AttributeValue Union: only one key present
            S: tenant,
          },
          "messageCid": {
            S: cid
          }
        },
        AttributesToGet: [ // AttributeNameList
          "tenant", "messageCid", "encodedMessageBytes", "encodedData"
        ]
      };
      //console.log(input);
      const command = new GetItemCommand(input);
      const response = await this.#client.send(command);
      response.Item

      if ( !response.Item ) {
        return undefined;
      }

      const result = {
          tenant: response.Item.tenant.S?.toString(),
          messageCid: response.Item.messageCid.S?.toString(),
          encodedMessageBytes: response.Item.encodedMessageBytes.B,
          encodedData: response.Item.encodedData?.S?.toString()
      };

    
      const responseData = await this.parseEncodedMessage(result.encodedMessageBytes ? result.encodedMessageBytes: Buffer.from(""), result.encodedData, options);
      //console.log(responseData);
      return responseData;
    } catch ( error ) {
      //console.log("FAILED TO GET");
      //console.error(error);
    }
  }

  async query(
    tenant: string,
    filters: Filter[],
    messageSort?: MessageSort,
    pagination?: Pagination,
    options?: MessageStoreOptions
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor}> {

    if ( filters ) {
      //console.log("FILTER FOUND");
      //console.log(filters);
    }

    if (!this.#client) {
      throw new Error(
        'Connection to database not open. Call `open` before using `query`.'
      );
    }

    options?.signal?.throwIfAborted();

    //console.log("QUERY")
    try {
      const { property: sortProperty, direction: sortDirection } = this.extractSortProperties(messageSort);

      let params: any = this.cursorInputSort(tenant, pagination, sortProperty, sortDirection);
    // if ( pagination?.cursor ) {
    //   if ( messageSort ) {
    //     params = this.cursorInputSort(tenant, pagination, sortProperty, sortDirection);
    //   } else {
    //     params = this.cursorInput(tenant, pagination)
    //   }
    // } else {
    //   params = {
    //     TableName: this.#tableName,
    //     KeyConditionExpression: '#tenant = :tenant',
    //     ExpressionAttributeNames: {
    //         '#tenant': "tenant" // Replace with your actual hash key attribute name
    //     },
    //     ExpressionAttributeValues: marshall({
    //         ':tenant': tenant
    //     })
    //   };

    //   if ( pagination?.limit ) {
    //     params["Limit"] = pagination.limit
    //   }
    //   if ( pagination?.cursor ) {
    //     params["ExclusiveStartKey"] = JSON.parse(pagination.cursor.messageCid)
    //   }
    // }
        //console.log("PARAMS");
        //console.log(params);
        const command = new QueryCommand(params);
        const data = await this.#client.send(command);
        //console.log("IS LASTEVAL: " + data.LastEvaluatedKey !== undefined);

        delete params["Limit"];
        //console.log(params);
        const command2 = new QueryCommand(params);
    
        const data2 = await this.#client.send(command2);
        //console.log(data2);
        //console.log(data2.ScannedCount);

        if ( data.ScannedCount !== undefined && data.Items !== undefined && data.ScannedCount > 0 && data.LastEvaluatedKey ) {
          let matches = true;
          for ( const key in data.LastEvaluatedKey ){
            if ( data.LastEvaluatedKey[key] !== data.Items[data.ScannedCount - 1].S ) {
              matches = false;
            }
          }
          if ( matches ) {
            delete data["LastEvaluatedKey"];
            //console.log("MATCHES, DELETE!");
          }
        }

        //console.log(data);

        // Extract and return the items from the response
        if (data.Items) {

          //console.log("BEFORE:");
          //console.log(data.Items.length);

          const filteredItems = data.Items.filter(item => {
            let filterMatchCount = 0;
            for (const filter of filters) {
              let innerFilterMatch = true; // we'll set to false if it doesn't match
              for ( const key in filter ){
                //console.log(key);
                const expectedValue = filter[key];
                // //console.log(expectedValue);
                // //console.log(item[key].S);
                // Check if item attribute matches expected value
                if (!item.hasOwnProperty(key) || item[key].S !== expectedValue) {
                  innerFilterMatch = false; // Exclude item from filteredItems
                }

              }
              // means all of the filter properties were met so we increment the filterMatchCount (indicating we had at least one match)
              if ( innerFilterMatch ) {
                filterMatchCount++;
              }
            }
            return filterMatchCount > 0; // Include item in filteredItems
          });

          //console.log("AFTER:");
          //console.log(filteredItems.length);

          //console.log("RAW RESULTS");
          //console.log(data);

          const results = await this.processPaginationResults(filteredItems, sortProperty, data.LastEvaluatedKey, pagination?.limit, options);
          //console.log("PROCESSED");
          //console.log(JSON.stringify(results, null, 2));
          return results;
        } else {
          return { messages: []};
        }
    } catch (err) {
        //console.error("Error retrieving items:", err);
        throw err;
    }




















    // if (!this.#db) {
    //   throw new Error(
    //     'Connection to database not open. Call `open` before using `query`.'
    //   );
    // }

    // options?.signal?.throwIfAborted();

    // // extract sort property and direction from the supplied messageSort
    // const { property: sortProperty, direction: sortDirection } = this.extractSortProperties(messageSort);

    // let query = this.#db
    //   .selectFrom('messageStoreMessages')
    //   .leftJoin('messageStoreRecordsTags', 'messageStoreRecordsTags.messageInsertId', 'messageStoreMessages.id')
    //   .select('messageCid')
    //   .distinct()
    //   .select([
    //     'encodedMessageBytes',
    //     'encodedData',
    //     sortProperty,
    //   ])
    //   .where('tenant', '=', tenant);

    // // filter sanitization takes place within `filterSelectQuery`
    // query = filterSelectQuery(filters, query);

    // if(pagination?.cursor !== undefined) {
    //   // currently the sort property is explicitly either `dateCreated` | `messageTimestamp` | `datePublished` which are all strings
    //   // TODO: https://github.com/TBD54566975/dwn-sdk-js/issues/664 to handle the edge case
    //   const cursorValue = pagination.cursor.value as string;
    //   const cursorMessageId = pagination.cursor.messageCid;

    //   query = query.where(({ eb, refTuple, tuple }) => {
    //     const direction = sortDirection === SortDirection.Ascending ? '>' : '<';
    //     // https://kysely-org.github.io/kysely-apidoc/interfaces/ExpressionBuilder.html#refTuple
    //     return eb(refTuple(sortProperty, 'messageCid'), direction, tuple(cursorValue, cursorMessageId));
    //   });
    // }

    // const orderDirection = sortDirection === SortDirection.Ascending ? 'asc' : 'desc';
    // // sorting by the provided sort property, the tiebreak is always in ascending order regardless of sort
    // query =  query
    //   .orderBy(sortProperty, orderDirection)
    //   .orderBy('messageCid', orderDirection);

    // if (pagination?.limit !== undefined && pagination?.limit > 0) {
    //   // we query for one additional record to decide if we return a pagination cursor or not.
    //   query = query.limit(pagination.limit + 1);
    // }

    // const results = await executeUnlessAborted(
    //   query.execute(),
    //   options?.signal
    // );

    // // prunes the additional requested message, if it exists, and adds a cursor to the results.
    // // also parses the encoded message for each of the returned results.
    // return this.processPaginationResults(results, sortProperty, pagination?.limit, options);
  }

  async delete(
    tenant: string,
    cid: string,
    options?: MessageStoreOptions
  ): Promise<void> {
    if (!this.#client) {
      throw new Error(
        'Connection to database not open. Call `open` before using `delete`.'
      );
    }

    options?.signal?.throwIfAborted();

    let deleteParams = {
      TableName: this.#tableName,
      Key: marshall({
          'tenant': tenant, // Adjust 'primaryKey' based on your table's partition key
          'messageCid': cid
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
          TableName: this.#tableName
      };

      let scanCommand = new ScanCommand(scanParams);
      let scanResult;
      
      do {
          scanResult = await this.#client.send(scanCommand);

          // Delete each item
          for (let item of scanResult.Items) {
              let deleteParams = {
                  TableName: this.#tableName,
                  Key: marshall({
                      'tenant': item.tenant.S.toString(), // Adjust 'primaryKey' based on your table's partition key
                      'messageCid': item.messageCid.S.toString()
                  })
              };
              
              let deleteCommand = new DeleteItemCommand(deleteParams);
              await this.#client.send(deleteCommand);
              //console.log("Deleted item successfully");
          }

          // Continue scanning if we have more items
          scanParams.ExclusiveStartKey = scanResult.LastEvaluatedKey;

      } while (scanResult.LastEvaluatedKey);

      //console.log("Successfully cleared all data from " + this.#tableName );
    } catch (err) {
        console.error('Unable to clear table:', err);
    }
  }

  private async parseEncodedMessage(
    encodedMessageBytes: Uint8Array,
    encodedData: string | null | undefined,
    options?: MessageStoreOptions
  ): Promise<GenericMessage> {
    options?.signal?.throwIfAborted();

    const decodedBlock = await block.decode({
      bytes  : encodedMessageBytes,
      codec  : cbor,
      hasher : sha256
    });

    const message = decodedBlock.value as GenericMessage;
    // If encodedData is stored within the MessageStore we include it in the response.
    // We store encodedData when the data is below a certain threshold.
    // https://github.com/TBD54566975/dwn-sdk-js/pull/456
    if (message !== undefined && encodedData !== undefined && encodedData !== null) {
      //console.log("WE GOT HERE");
      //console.log(encodedData);
      (message as any).encodedData = encodedData;
    }
    return message;
  }

  /**
   * Processes the paginated query results.
   * Builds a pagination cursor if there are additional messages to paginate.
   * Accepts more messages than the limit, as we query for additional records to check if we should paginate.
   *
   * @param messages a list of messages, potentially larger than the provided limit.
   * @param limit the maximum number of messages to be returned
   *
   * @returns the pruned message results and an optional pagination cursor
   */
  private async processPaginationResults(
    results: any[],
    sortProperty: string,
    lastEvaluatedKey: any,
    limit?: number,
    options?: MessageStoreOptions,
  ): Promise<{ messages: GenericMessage[], cursor?: PaginationCursor}> {
    // we queried for one additional message to determine if there are any additional messages beyond the limit
    // we now check if the returned results are greater than the limit, if so we pluck the last item out of the result set
    // the cursor is always the last item in the *returned* result so we use the last item in the remaining result set to build a cursor
    let cursor: PaginationCursor | undefined;
    // if (limit !== undefined && results.length == limit) {
    //   const lastMessage = results.at(-1);
    //   const cursorValue = lastMessage[sortProperty];
    //   cursor = { messageCid: lastEvaluatedKey, value: cursorValue };
    // }
    if ( lastEvaluatedKey !== null && lastEvaluatedKey !== undefined ) {
      cursor = { messageCid: JSON.stringify(lastEvaluatedKey), value: JSON.stringify(lastEvaluatedKey) };
      //console.log("CURSOR EXISTS");
      //console.log(cursor);
    }

    // extracts the full encoded message from the stored blob for each result item.
    const messages: Promise<GenericMessage>[] = results.map(r => this.parseEncodedMessage(new Uint8Array(r.encodedMessageBytes.B), r.encodedData?.S, options));
    return { messages: await Promise.all(messages), cursor };
  }

  /**
   * Extracts the appropriate sort property and direction given a MessageSort object.
   */
  private extractSortProperties(
    messageSort?: MessageSort
  ):{ property: 'dateCreated' | 'datePublished' | 'messageTimestamp', direction: SortDirection } {
    if(messageSort?.dateCreated !== undefined)  {
      return  { property: 'dateCreated', direction: messageSort.dateCreated };
    } else if(messageSort?.datePublished !== undefined) {
      return  { property: 'datePublished', direction: messageSort.datePublished };
    } else if (messageSort?.messageTimestamp !== undefined) {
      return  { property: 'messageTimestamp', direction: messageSort.messageTimestamp };
    } else {
      return  { property: 'messageTimestamp', direction: SortDirection.Ascending };
    }
  }

  /**
   * Extracts the appropriate sort property and direction given a MessageSort object.
   */
  private cursorInputSort(
    tenant: string,
    pagination: Pagination|undefined,
    sortAttribute: string,
    sortDirection: SortDirection
  ): any {
    try {
      const direction = sortDirection == SortDirection.Ascending ? true : false;
      const params: QueryCommandInput = {
        TableName: this.#tableName,
        KeyConditionExpression: '#tenant = :tenant',
        ExpressionAttributeNames: {
            '#tenant': "tenant" // Replace with your actual hash key attribute name
        },
        ExpressionAttributeValues: marshall({
            ':tenant': tenant
        }),
        ScanIndexForward: direction,
        
      };

      if ( sortAttribute ) {
        params["IndexName"] = sortAttribute
        if ( direction ) {
          params["ScanIndexForward"] = direction
        }
      }

      if ( pagination?.limit ) {
        params["Limit"] = pagination.limit
      }
      if ( pagination?.cursor ) {
        params["ExclusiveStartKey"] = JSON.parse(pagination.cursor.messageCid);
      }
      //console.log(params);
      return params;
    } catch (error) {
      //console.log("Caught error:");
      //console.log(error);
      throw error;
    }
  }
}