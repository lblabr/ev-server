/* eslint-disable @typescript-eslint/member-ordering */
import { BillingDataTransactionStart, BillingDataTransactionStop, BillingDataTransactionUpdate, BillingInvoice, BillingInvoiceDocument, BillingInvoiceItem, BillingInvoiceStatus, BillingOperationResult, BillingStatus, BillingTax, BillingUser, BillingUserData } from '../../../types/Billing';
import { DocumentEncoding, DocumentType } from '../../../types/GlobalType';

import AxiosFactory from '../../../utils/AxiosFactory';
import { AxiosInstance } from 'axios';
import BackendError from '../../../exception/BackendError';
import BillingIntegration from '../BillingIntegration';
import BillingStorage from '../../../storage/mongodb/BillingStorage';
import Constants from '../../../utils/Constants';
import Cypher from '../../../utils/Cypher';
import Decimal from 'decimal.js';
import I18nManager from '../../../utils/I18nManager';
import Logging from '../../../utils/Logging';
import { Request } from 'express';
import { ServerAction } from '../../../types/Server';
import Stripe from 'stripe';
import { StripeBillingSetting } from '../../../types/Setting';
import Transaction from '../../../types/Transaction';
import User from '../../../types/User';
import UserStorage from '../../../storage/mongodb/UserStorage';
import Utils from '../../../utils/Utils';
import moment from 'moment';

const MODULE_NAME = 'StripeBillingIntegration';
export default class StripeBillingIntegration extends BillingIntegration<StripeBillingSetting> {

  private static readonly STRIPE_MAX_LIST = 100;
  private axiosInstance: AxiosInstance;
  private stripe: Stripe;

  constructor(tenantId: string, settings: StripeBillingSetting) {
    super(tenantId, settings);
    this.axiosInstance = AxiosFactory.getAxiosInstance(this.tenantID);
  }

  public static checkSettingsConsistency(settings: StripeBillingSetting): boolean {
    if (settings.url && settings.secretKey && settings.publicKey) {
      return true;
    }
    // STRIPE prerequisites are not met
    return false ;
  }

  public async getStripeInstance(): Promise<Stripe> {
    // TODO - To be removed - only used by automated tests!
    await this.checkConnection();
    return this.stripe;
  }

  // public alterStripeSettings(someSettings: Partial<StripeBillingSetting>): void {
  //   // TODO - To be removed - only used by automated tests!
  //   this.settings = {
  //     ...this.settings,
  //     ...someSettings // overrides default settings to test different scenarios - e.g.: VAT 20%
  //   };
  // }

  public async checkConnection(): Promise<void> {
    // Initialize Stripe
    if (!this.stripe) {
      // STRIPE not yet initialized - let's do it!
      this.settings.secretKey = await Cypher.decrypt(this.tenantID, this.settings.secretKey);
      // Check Key
      if (!this.settings.secretKey) {
        throw new BackendError({
          source: Constants.CENTRAL_SERVER,
          module: MODULE_NAME, method: 'checkConnection',
          action: ServerAction.CHECK_CONNECTION,
          message: 'No secret key provided for connection to Stripe'
        });
      }
      this.stripe = new Stripe(this.settings.secretKey, {
        apiVersion: '2020-08-27',
      });
      // Let's check if the connection is working properly
      if (!this.stripe) {
        throw new BackendError({
          source: Constants.CENTRAL_SERVER,
          module: MODULE_NAME, method: 'checkConnection',
          action: ServerAction.CHECK_CONNECTION,
          message: 'Failed to connect to Stripe'
        });
      }
      // Validate the connection
      let isKeyValid = false;
      try {
        // Get one customer
        const list = await this.stripe.customers.list(
          { limit: 1 }
        );
        if (('object' in list) &&
          (list.object === 'list')) {
          isKeyValid = true;
        }
      } catch (error) {
        throw new BackendError({
          source: Constants.CENTRAL_SERVER,
          module: MODULE_NAME, method: 'checkConnection',
          action: ServerAction.CHECK_CONNECTION,
          message: `Error occurred when connecting to Stripe: ${error.message as string}`,
          detailedMessages: { error: error.message, stack: error.stack }
        });
      }
      if (!isKeyValid) {
        throw new BackendError({
          source: Constants.CENTRAL_SERVER,
          module: MODULE_NAME, method: 'checkConnection',
          action: ServerAction.CHECK_CONNECTION,
          message: 'Error occurred when connecting to Stripe: Invalid key'
        });
      }
    }
  }

  public async getUsers(): Promise<BillingUser[]> {
    const users = [];
    let request;
    const requestParams: Stripe.CustomerListParams = { limit: StripeBillingIntegration.STRIPE_MAX_LIST };
    // Check Stripe
    await this.checkConnection();
    do {
      request = await this.stripe.customers.list(requestParams);
      for (const customer of request.data) {
        users.push({
          email: customer.email,
          billingData: {
            customerID: customer.id
          }
        });
      }
      if (request.has_more) {
        requestParams.starting_after = users[users.length - 1].billingData.customerID;
      }
    } while (request.has_more);
    return users;
  }

  private convertToBillingUser(customer: Stripe.Customer, user: User) : BillingUser {
    // Check for the deletion flag
    const deleted: boolean = customer?.deleted as unknown as boolean; // ACHTUNG - Hack because STRIPE type definition is wrong!
    if (customer && !deleted) {
      const previousBillingData = user?.billingData;
      const newBillingData: BillingUserData = {
        ...previousBillingData, // Preserve previous values if any
        customerID: customer.id,
        lastChangedOn: new Date(),
        hasSynchroError: false
      };
      const userID = customer.metadata?.['userID'];
      const billingUser: BillingUser = {
        userID,
        name: customer.name,
        billingData: newBillingData
      };
      return billingUser;
    }
    // return null when the customer is marked as deleted in STRIPE
    return null;
  }

  public async userExists(user: User): Promise<boolean> {
    // Check Stripe
    await this.checkConnection();
    // Make sure the billing data has been provided
    if (!user.billingData) {
      user = await UserStorage.getUser(this.tenantID, user.id);
    }
    // Retrieve the STRIPE customer (if any)
    const customerID: string = user?.billingData?.customerID;
    const customer = await this.getStripeCustomer(customerID);
    return !!customer;
  }

  public async getUser(user: User): Promise<BillingUser> {
    // Check Stripe
    await this.checkConnection();
    // Make sure the billing data has been provided
    if (!user.billingData) {
      user = await UserStorage.getUser(this.tenantID, user.id);
    }
    // Retrieve the STRIPE customer (if any)
    const customerID: string = user.billingData?.customerID;
    const customer = await this.getStripeCustomer(customerID);
    if (!customer) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME, method: 'getStripeCustomer',
        action: ServerAction.BILLING,
        message: `STRIPE Customer not found: ${customerID}`,
      });
    }

    // Return the corresponding  Billing User
    return this.convertToBillingUser(customer, user);
  }

  public async getTaxes(): Promise<BillingTax[]> {
    const taxes = [] as BillingTax[];
    let request;
    const requestParams : Stripe.TaxRateListParams = { limit: StripeBillingIntegration.STRIPE_MAX_LIST };
    do {
      request = await this.stripe.taxRates.list(requestParams);
      for (const tax of request.data) {
        taxes.push({
          id: tax.id,
          description: tax.description,
          displayName: tax.display_name,
          percentage: tax.percentage
        });
      }
      if (request.has_more) {
        requestParams.starting_after = taxes[taxes.length - 1].id;
      }
    } while (request.has_more);
    return taxes;
  }

  public async getStripeInvoice(id: string): Promise<Stripe.Invoice> {
    // Get Invoice
    const stripeInvoice = await this.stripe.invoices.retrieve(id);
    return stripeInvoice;
  }

  // TODO - name of the method is confusing - the returned value is a partial billing invoice (id is null)
  public async getInvoice(id: string): Promise<BillingInvoice> {
    // Check Stripe
    await this.checkConnection();
    // Get Invoice
    try {
      const stripeInvoice = await this.stripe.invoices.retrieve(id);
      const { id: invoiceID, customer, number, amount_due: amount, amount_paid: amountPaid, status, currency, invoice_pdf: downloadUrl } = stripeInvoice;
      const nbrOfItems: number = this.getNumberOfItems(stripeInvoice);
      const customerID = customer as string;
      const billingInvoice: BillingInvoice = {
        id: null, // TODO - must be clarified - We cannot guess the Billing Invoice ID
        invoiceID,
        customerID,
        number,
        amount,
        amountPaid,
        status: status as BillingInvoiceStatus,
        currency,
        createdOn: new Date(stripeInvoice.created * 1000),
        nbrOfItems: nbrOfItems,
        downloadUrl,
        downloadable: !!downloadUrl
      };
      return billingInvoice;
    } catch (e) {
      // TODO - This is suspicious
      return null;
    }
  }

  private getNumberOfItems(stripeInvoice: Stripe.Invoice): number {
    // STRIPE version 8.137.0 - total_count property is deprecated - TODO - find another way to get it!
    const nbrOfItems: number = stripeInvoice.lines['total_count'];
    return nbrOfItems;
  }

  public async getUpdatedUserIDsInBilling(): Promise<string[]> {
    const createdSince = this.settings.usersLastSynchronizedOn ? moment(this.settings.usersLastSynchronizedOn).unix() : 0;
    const collectedCustomerIDs: string[] = [];
    const queryRange: Stripe.RangeQueryParam = { gt: createdSince };
    const request: Stripe.EventListParams = {
      created: queryRange,
      limit: StripeBillingIntegration.STRIPE_MAX_LIST,
      type: 'customer.*',
    };
    // Check Stripe
    await this.checkConnection();
    // Loop until all users are read
    do {
      const events: Stripe.ApiList<Stripe.Event> = await this.stripe.events.list(request);
      for (const evt of events.data) {
        // c.f.: https://stripe.com/docs/api/events/object
        const customer: Stripe.Customer = evt.data.object as Stripe.Customer; // TODO - to be clarified how to determine the object type?
        if (customer.object === 'customer' && customer.id) {
          if (!collectedCustomerIDs.includes(customer.id)) {
            collectedCustomerIDs.push(customer.id);
          }
        }
      }
      if (request['has_more']) {
        request['starting_after'] = collectedCustomerIDs[collectedCustomerIDs.length - 1];
      }
    } while (request['has_more']);
    return collectedCustomerIDs;
  }

  public async getUpdatedInvoiceIDsInBilling(billingUser?: BillingUser): Promise<string[]> {
    let createdSince: number;
    // Check Stripe
    await this.checkConnection();
    if (billingUser) {
      // Start sync from last invoices sync
      createdSince = billingUser.billingData.invoicesLastSynchronizedOn ? moment(billingUser.billingData.invoicesLastSynchronizedOn).unix() : 0;
    } else {
      // Start sync from last global sync
      createdSince = this.settings.invoicesLastSynchronizedOn ? moment(this.settings.invoicesLastSynchronizedOn).unix() : 0;
    }
    const collectedInvoiceIDs: string[] = [];
    const queryRange: Stripe.RangeQueryParam = { gt: createdSince };
    const request: Stripe.EventListParams = {
      created: queryRange,
      limit: StripeBillingIntegration.STRIPE_MAX_LIST,
      type: 'invoice.*',
    };
    // Loop until all invoices are read
    do {
      const events: Stripe.ApiList<Stripe.Event> = await this.stripe.events.list(request);
      for (const evt of events.data) {
        // c.f.: https://stripe.com/docs/api/events/object
        const invoice: Stripe.Invoice = evt.data.object as Stripe.Invoice; // TODO - to be clarified how to determine the object type?
        if (invoice.object === 'invoice' && invoice.id) {
          if (!collectedInvoiceIDs.includes(invoice.id)) {
            if (billingUser) {
              // Collect specific user's invoices
              if (billingUser.billingData.customerID === invoice.customer) {
                collectedInvoiceIDs.push(invoice.id);
              }
            } else {
              // Collect every invoices
              collectedInvoiceIDs.push(invoice.id);
            }
          }
        }
      }
      if (request['has_more']) {
        request['starting_after'] = collectedInvoiceIDs[collectedInvoiceIDs.length - 1];
      }
    } while (request['has_more']);
    return collectedInvoiceIDs;
  }

  private async _createStripeInvoice(customerID: string, userID: string, idempotencyKey?: string | number): Promise<Stripe.Invoice> {
    // Let's create the STRIPE invoice
    const stripeInvoice: Stripe.Invoice = await this.stripe.invoices.create({
      customer: customerID,
      collection_method: 'send_invoice', // TODO - must be clarified - other option is 'charge_automatically' ==> triggering an implicit payment!
      days_until_due: 30, // TODO - must be clarified - get rid of this hardcoded default value
      auto_advance: false, // our integration is responsible for transitioning the invoice between statuses
      metadata: {
        userID
      }
    }, {
      // idempotency_key: idempotencyKey?.toString(),
      idempotencyKey: idempotencyKey?.toString(), // STRIPE version 8.137.0 - property as been renamed!!!
    });
    return stripeInvoice;
  }

  public async synchronizeAsBillingInvoice(stripeInvoiceID: string): Promise<BillingInvoice> {
    // Make sure to get fresh data !
    const stripeInvoice: Stripe.Invoice = await this.getStripeInvoice(stripeInvoiceID);
    if (!stripeInvoice) {
      throw new BackendError({
        message: `Unexpected situation - invoice not found - ${stripeInvoiceID}`,
        source: Constants.CENTRAL_SERVER, module: MODULE_NAME, action: ServerAction.BILLING,
        method: '_replicateStripeInvoice',
      });
    }
    // Destructuring the STRIPE invoice to extract the required information
    const { id: invoiceID, customer, number, amount_due: amount, amount_paid: amountPaid, status, currency, invoice_pdf: downloadUrl, metadata } = stripeInvoice;
    const customerID = customer as string;
    const createdOn = moment.unix(stripeInvoice.created).toDate(); // epoch to Date!
    // Check metadata consistency - userID is mandatory!
    const userID = metadata?.userID;
    if (!userID) {
      throw new BackendError({
        message: `Unexpected situation - invoice is not an e-Mobility invoice - ${stripeInvoiceID}`,
        source: Constants.CENTRAL_SERVER, module: MODULE_NAME, action: ServerAction.BILLING,
        method: 'synchronizeAsBillingInvoice',
      });
    }
    // Get the corresponding BillingInvoice (if any)
    const billingInvoice: BillingInvoice = await BillingStorage.getInvoiceByInvoiceID(this.tenantID, stripeInvoice.id);
    const nbrOfItems: number = this.getNumberOfItems(stripeInvoice);
    const invoiceToSave: BillingInvoice = {
      id: billingInvoice?.id, // ACHTUNG: billingInvoice is null when creating the Billing Invoice
      userID, invoiceID, customerID, number, amount, amountPaid, currency, createdOn, nbrOfItems, downloadUrl, downloadable: !!downloadUrl,
      status: status as BillingInvoiceStatus,
    };
    // Let's persist the up-to-date data
    const freshInvoiceId = await BillingStorage.saveInvoice(this.tenantID, invoiceToSave);
    const freshBillingInvoice = await BillingStorage.getInvoice(this.tenantID, freshInvoiceId);
    if (freshBillingInvoice?.downloadable) {
      // Replicate the invoice as a PDF document
      const invoiceDocument = await this.downloadInvoiceDocument(freshBillingInvoice);
      await BillingStorage.saveInvoiceDocument(this.tenantID, invoiceDocument);
    }
    return freshBillingInvoice;
  }

  private async _createStripeInvoiceItem(parameters: Stripe.InvoiceItemCreateParams, idempotencyKey: string | number): Promise<Stripe.InvoiceItem> {
    // Let's create the line item
    const stripeInvoiceItem = await this.stripe.invoiceItems.create(parameters, {
      // idempotency_key: idempotencyKey?.toString()
      idempotencyKey: idempotencyKey?.toString(), // STRIPE version 8.137.0 - property as been renamed!!!
    });
      // returns the newly created invoice item
    return stripeInvoiceItem;
  }

  private getTaxRateIds(): Array<string> {
    // TODO - just a hack for now - tax rate should be part of the billing settings
    // return [ 'txr_1IP3FJKHtGlSi68frTdAro48' ];
    if (this.settings.taxID) {
      return [this.settings.taxID] ;
    }
    return []; // No tax rates so far!
  }

  public async downloadInvoiceDocument(invoice: BillingInvoice): Promise<BillingInvoiceDocument> {
    if (invoice.downloadUrl && invoice.downloadUrl !== '') {
      // Get document
      const response = await this.axiosInstance.get(invoice.downloadUrl, {
        responseType: 'arraybuffer'
      });
      // Convert
      const base64Image = Buffer.from(response.data).toString('base64');
      const content = 'data:' + response.headers['content-type'] + ';base64,' + base64Image;
      return {
        id: invoice.id,
        invoiceID: invoice.invoiceID,
        content: content,
        type: DocumentType.PDF,
        encoding: DocumentEncoding.BASE64
      };
    }
  }

  // No use-case so far - exposing it at the Billing Integration level is useless
  // public async finalizeInvoice(invoice: BillingInvoice): Promise<string> {
  //   await this.checkConnection();
  //   try {
  //     const stripeInvoice = await this.stripe.invoices.finalizeInvoice(invoice.invoiceID);
  //     invoice.downloadUrl = stripeInvoice.invoice_pdf;
  //     invoice.status = BillingInvoiceStatus.OPEN;
  //     invoice.downloadable = true;
  //     await BillingStorage.saveInvoice(this.tenantID, invoice);
  //     const invoiceDocument = await this.downloadInvoiceDocument(invoice);
  //     await BillingStorage.saveInvoiceDocument(this.tenantID, invoiceDocument);
  //     return stripeInvoice.invoice_pdf;
  //   } catch (error) {
  //     throw new BackendError({
  //       message: 'Failed to finalize invoice',
  //       source: Constants.CENTRAL_SERVER,
  //       module: MODULE_NAME,
  //       method: 'finalizeInvoice',
  //       action: ServerAction.BILLING_SEND_INVOICE
  //     });
  //   }
  // }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async consumeBillingEvent(req: Request): Promise<boolean> {
    let event: { data, type: string };
    if (process.env.STRIPE_WEBHOOK_SECRET) { // ##CR - to be clarified - where this secret key should come from
      // Retrieve the event by verifying the signature using the raw body and secret.
      const signature = req.headers['stripe-signature'];
      try {
        event = this.stripe.webhooks.constructEvent(
          req.body, // Req.rawBody,
          signature,
          process.env.STRIPE_WEBHOOK_SECRET
        );
      } catch (err) {
        console.log('⚠️  Webhook signature verification failed.');
        // Return res.sendStatus(400);
        return false; // ##CR - this is stupid
      }
    } else {
      // Webhook signing is recommended, but if the secret is not known
      // we can retrieve the event data directly from the request body.
      event = {
        data: req.body.data,
        type: req.body.type
      };
    }
    if (event.type === 'payment_intent.succeeded') {
      // The payment was complete
      // Fulfill any orders, e-mail receipts, etc
      console.log('💰 Payment succeeded with payment method ' + event.data.object.payment_method);
    } else if (event.type === 'payment_intent.payment_failed') {
      // The payment failed to go through due to decline or authentication request
      const error = event.data.object.last_payment_error.message;
      console.log('❌ Payment failed with error: ' + error);
    } else if (event.type === 'payment_method.attached') {
      // A new payment method was attached to a customer
      console.log('💳 Attached ' + event.data.object.id + ' to customer');
    } else {
      console.log(`❌ unexpected event : ${event.type}`);
    }
    return true;
  }

  public async chargeInvoice(billingInvoice: BillingInvoice): Promise<BillingInvoice> {
    await this.checkConnection();
    try {
      const billingOperationResult: BillingOperationResult = await this._chargeStripeInvoice(billingInvoice.invoiceID);
      billingInvoice = await this.synchronizeAsBillingInvoice(billingInvoice.invoiceID);
      if (!billingOperationResult.succeeded) {
        // TODO - how to determine the root cause of the error
        await BillingStorage.saveLastPaymentFailure(this.tenantID, billingInvoice.id, billingOperationResult);
      }
      return billingInvoice;
    } catch (error) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME, method: 'chargeInvoice',
        action: ServerAction.BILLING,
        message: `Stripe Operation Failed: ${error.message as string}`,
        detailedMessages: { error: error.message, stack: error.stack }
      });
    }
  }

  private async _chargeStripeInvoice(invoiceID: string): Promise<BillingOperationResult> {
    // Fetch the invoice from stripe (do NOT TRUST the local copy)
    let stripeInvoice: Stripe.Invoice = await this.stripe.invoices.retrieve(invoiceID);
    // Check the current invoice status
    if (stripeInvoice.status !== 'paid') {
      // Finalize the invoice (if necessary)
      if (stripeInvoice.status === 'draft') {
        stripeInvoice = await this.stripe.invoices.finalizeInvoice(invoiceID);
      }
      // Once finalized, the invoice is in the "open" state!
      if (stripeInvoice.status === 'open') {
        // Set the payment options
        const paymentOptions: Stripe.InvoicePayParams = {};
        try {
          stripeInvoice = await this.stripe.invoices.pay(invoiceID, paymentOptions);
        } catch (error) {
          return this.shrinkStripeFailure(error);
        }
      }
    }
    return {
      succeeded: true,
      internalData: stripeInvoice
    };
  }

  private shrinkStripeFailure(error): BillingOperationResult {
    // Let's extract the data that we might be interested in
    const { type, rawType, message, code, decline_code, payment_intent, payment_method, payment_method_type } = error;
    // Wrap it in a format that we can consume!
    const billingOperationResult: BillingOperationResult = {
      succeeded: false,
      error: {
        message,
        context: {
          type,
          rawType,
          code,
          declineCode: decline_code,
          paymentIntentID: payment_intent?.id,
          paymentMethodID: payment_method?.id,
          paymentMethodType: payment_method_type
        }
      }
    };
    return billingOperationResult;
  }

  public async setupPaymentMethod(user: User, paymentMethodId: string): Promise<BillingOperationResult> {
    // Check Stripe
    await this.checkConnection();
    // Check billing data consistency
    if (!user?.billingData?.customerID) {
      throw new BackendError({
        message: 'User is not yet known in Stripe',
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME,
        method: 'setupPaymentMethod',
        action: ServerAction.BILLING_TRANSACTION
      });
    }

    let billingOperationResult: BillingOperationResult;
    const customerID = user.billingData.customerID;
    if (!paymentMethodId) {
      // Let's create a setupIntent for the stripe customer
      billingOperationResult = await this._createSetupIntent(user, customerID);
    } else {
      // Attach payment method to the stripe customer
      billingOperationResult = await this._attachPaymentMethod(user, customerID, paymentMethodId);
    }
    return billingOperationResult;
  }

  private async _createSetupIntent(user: User, customerID: string): Promise<BillingOperationResult> {
    try {
      // Let's create a setupIntent for the stripe customer
      const setupIntent: Stripe.SetupIntent = await this.stripe.setupIntents.create({
        customer: customerID
      });
      await Logging.logInfo({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.BILLING_SETUP_PAYMENT_METHOD,
        module: MODULE_NAME, method: '_createSetupIntent',
        message: `Setup intent has been created - customer '${customerID}' - (${user.email})`
      });
      // Send some feedback
      return {
        succeeded: true,
        internalData: setupIntent
      };
    } catch (error) {
      // catch stripe errors and send the information back to the client
      await Logging.logError({
        tenantID: this.tenantID,
        action: ServerAction.BILLING_SETUP_PAYMENT_METHOD,
        actionOnUser: user,
        module: MODULE_NAME, method: '_createSetupIntent',
        message: `Stripe operation failed - ${error?.message as string}`
      });
      const billingOperationResult: BillingOperationResult = {
        succeeded: false,
        error: {
          message: error?.message
        }
      };
      return billingOperationResult;
    }
  }

  private async _attachPaymentMethod(user: User, customerID: string, paymentMethodId: string): Promise<BillingOperationResult> {
    try {
      // Attach payment method to the stripe customer
      const paymentMethod: Stripe.PaymentMethod = await this.stripe.paymentMethods.attach(paymentMethodId, {
        customer: customerID
      });
      await Logging.logInfo({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.BILLING_SETUP_PAYMENT_METHOD,
        module: MODULE_NAME, method: '_attachPaymentMethod',
        message: `Payment method ${paymentMethodId} has been attached - customer '${customerID}' - (${user.email})`
      });
      // Set this payment method as the default
      await this.stripe.customers.update(customerID, {
        invoice_settings: { default_payment_method: paymentMethodId }
      });
      await Logging.logInfo({
        tenantID: this.tenantID,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.BILLING_SETUP_PAYMENT_METHOD,
        module: MODULE_NAME, method: '_attachPaymentMethod',
        message: `Default payment method has been set ${paymentMethodId} - customer '${customerID}' - (${user.email})`
      });
      // Send some feedback
      return {
        succeeded: true,
        internalData: paymentMethod
      };
    } catch (e) {
      // catch stripe errors and send the information back to the client
      await Logging.logError({
        tenantID: this.tenantID,
        action: ServerAction.BILLING_SETUP_PAYMENT_METHOD,
        actionOnUser: user,
        module: MODULE_NAME, method: '_attachPaymentMethod',
        message: `Stripe operation failed - ${e?.message as string}`
      });
      const billingOperationResult: BillingOperationResult = {
        succeeded: false,
        error: {
          message: e?.message
        }
      };
      return billingOperationResult;
    }
  }

  public async startTransaction(transaction: Transaction): Promise<BillingDataTransactionStart> {
    // Check Stripe
    await this.checkConnection();
    // Check Transaction
    this.checkStartTransaction(transaction);

    if (this.__liveMode) {
      // Check that the customer STRIPE exists
      const customerID: string = transaction.user?.billingData?.customerID;
      const customer = await this.getStripeCustomer(customerID);
      if (!customer) {
        throw new BackendError({
          message: `Stripe customer ID of the transaction user is invalid - ${customerID}`,
          source: Constants.CENTRAL_SERVER,
          module: MODULE_NAME,
          method: 'startTransaction',
          action: ServerAction.BILLING_TRANSACTION
        });
      }
    } else {
      // Not yet LIVE ... starting a transaction without a STRIPE CUSTOMER is allowed
    }
    return {
      cancelTransaction: false
    };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async updateTransaction(transaction: Transaction): Promise<BillingDataTransactionUpdate> {
    // Check User
    if (!transaction.userID || !transaction.user) {
      throw new BackendError({
        message: 'User is not provided',
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME,
        method: 'updateTransaction',
        action: ServerAction.BILLING_TRANSACTION
      });
    }
    return {
      cancelTransaction: false
    };
  }

  private _buildInvoiceItemParameters(customerID: string, billingInvoiceItem: BillingInvoiceItem, invoiceID?: string): Stripe.InvoiceItemCreateParams {
    /* --------------------------------------------------------------------------------
     Convert pricing information to STRIPE expected data
    -----------------------------------------------------------------------------------
    Example:
      Consumption 1000 Kw.h - total amount: 4 euros
      Unit price should be (4 / 1000) ==> 0.004
    Stripe expects 'unit_amount' as an Integer, in Cents
      unit_amount: 0.4 ==> Not an integer - throws an exception
    Stripe alternative - 'unit_amount_decimal' in Cents, with 2 decimals, as a string!
      unit_amount_decimal: '004.00' (in Cents, with 2 decimals, as a string)
    ----------------------------------------------------------------------------------- */
    const { description, pricingData, taxes } = billingInvoiceItem;
    const currency = pricingData.currency.toLowerCase();
    // Build stripe parameters for the item
    const parameters: Stripe.InvoiceItemCreateParams = {
      invoice: invoiceID,
      customer: customerID,
      currency,
      description,
      tax_rates: taxes,
      // quantity: 1, //Cannot be set separately
      amount: new Decimal(pricingData.amount).times(100).round().toNumber(),
      metadata: { ...billingInvoiceItem?.metadata }
    };

    // // ----------------------------------------------------------------------------------------
    // // INVESTIGATIONS - Attempts to set both the quantity and the unit_amount
    // // ----------------------------------------------------------------------------------------
    // Quantity must be an Integer! - STRIPE does not support decimals
    // const quantity = new Decimal(pricingData.quantity).round().toNumber(); // kW.h -
    // if (quantity === 0) {
    //   // ----------------------------------------------------------------------------------------
    //   // The quantity was too small - let's prevent dividing by zero
    //   // parameters.quantity = 0; // Not an option for STRIPE
    //   // ----------------------------------------------------------------------------------------
    //   parameters.amount = new Decimal(pricingData.amount).times(100).round().toNumber();
    // } else {
    //   // ----------------------------------------------------------------------------------------
    //   // STRIPE expects either "unit_amount" in Cents - or unit_amount_decimal (with 4 decimals)
    //   // ----------------------------------------------------------------------------------------
    //   const unit_amount_in_cents = new Decimal(pricingData.amount).times(100).dividedBy(quantity);
    //   // Let's use the more precise option
    //   const unit_amount_decimal: string = unit_amount_in_cents.times(100).round().dividedBy(100).toNumber().toFixed(2);
    //   parameters.quantity = quantity;
    //   parameters.unit_amount_decimal = unit_amount_decimal;
    // }

    if (!parameters.invoice) {
      // STRIPE throws an exception when invoice is set to null.
      delete parameters.invoice;
    }
    return parameters;
  }

  public async stopTransaction(transaction: Transaction): Promise<BillingDataTransactionStop> {
    // Check Stripe
    await this.checkConnection();
    // Check object
    this.checkStopTransaction(transaction);
    try {
      // Check that the customer STRIPE exists
      const customerID: string = transaction.user?.billingData?.customerID;
      const customer = await this.getStripeCustomer(customerID);
      if (customer) {
        const billingDataTransactionStop: BillingDataTransactionStop = await this.billTransaction(transaction);
        return billingDataTransactionStop;
      } else if (this.__liveMode) {
        // This should not happen - the startTransaction should have been rejected
        throw new Error(`Unexpected situation - No STRIPE customer - Transaction ID '${transaction.id}'`);
      }
    } catch (error) {
      await Logging.logError({
        tenantID: this.tenantID,
        user: transaction.userID,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.BILLING_TRANSACTION,
        module: MODULE_NAME, method: 'stopTransaction',
        message: `Failed to bill the transaction - Transaction ID '${transaction.id}'`,
        detailedMessages: { error: error.message, stack: error.stack }
      });
    }

    return {
      status: BillingStatus.UNBILLED
    };
  }

  private async _getLatestDraftInvoice(customerID: string): Promise<Stripe.Invoice> {
    const list = await this.stripe.invoices.list({
      customer: customerID,
      status: BillingInvoiceStatus.DRAFT,
      limit: 1
    });
    return (list.data.length > 0) ? list.data[0] : null;
  }

  public async billTransaction(transaction: Transaction): Promise<BillingDataTransactionStop> {
    // ACHTUNG: a single transaction may generate several lines in the invoice
    const invoiceItem: BillingInvoiceItem = this.convertToBillingInvoiceItem(transaction);
    const billingInvoice = await this.billInvoiceItem(transaction.user, invoiceItem, `${transaction.id}`);
    // Send a notification to the user
    void this.sendInvoiceNotification(billingInvoice);
    return {
      status: BillingStatus.BILLED,
      invoiceID: billingInvoice.id,
      invoiceStatus: billingInvoice.status,
      invoiceItem
    };
  }

  private convertToBillingInvoiceItem(transaction: Transaction) : BillingInvoiceItem {
    // Destructuring transaction.stop
    const { price, priceUnit, roundedPrice, totalConsumptionWh, timestamp } = transaction.stop;
    // TODO - make it more precise - Pricing transparency!
    const description = this.buildLineItemDescription(transaction);
    // -------------------------------------------------------------------------------
    // ACHTUNG - STRIPE expects the amount and prices in CENTS!
    // -------------------------------------------------------------------------------
    const quantity = new Decimal(transaction.stop.totalConsumptionWh).dividedBy(1000).toNumber(); // Total consumption in kW.h
    const amount = roundedPrice; // Total amount for the line item
    const currency = priceUnit;
    // -------------------------------------------------------------------------------
    const taxes = this.getTaxRateIds(); // TODO - take into account SITE settings
    // Build a billing invoice item based on the transaction
    const billingInvoiceItem: BillingInvoiceItem = {
      description,
      pricingData: {
        quantity,
        amount,
        currency
      },
      taxes,
      metadata: {
        // Let's keep track of the initial data for troubleshooting purposes
        userID: transaction.userID,
        price,
        roundedPrice,
        priceUnit,
        totalConsumptionWh,
        begin: transaction.timestamp?.valueOf(),
        end: timestamp?.valueOf()
      }
    };
    return billingInvoiceItem ;
  }

  public async billInvoiceItem(user: User, billingInvoiceItem: BillingInvoiceItem, idemPotencyKey?: string): Promise<BillingInvoice> {
    // Let's collect the required information
    const userID: string = user.id;
    const customerID: string = user.billingData?.customerID;
    // Check whether a DRAFT invoice can be used
    let stripeInvoice = await this._getLatestDraftInvoice(customerID);
    const invoiceItemParameters: Stripe.InvoiceItemCreateParams = this._buildInvoiceItemParameters(customerID, billingInvoiceItem, stripeInvoice?.id);
    const stripeInvoiceItem = await this._createStripeInvoiceItem(invoiceItemParameters, this.buildIdemPotencyKey(idemPotencyKey, true));
    if (!stripeInvoiceItem) {
      await Logging.logError({
        tenantID: this.tenantID,
        user: user.id,
        source: Constants.CENTRAL_SERVER,
        action: ServerAction.BILLING_TRANSACTION,
        module: MODULE_NAME, method: 'billInvoiceItem',
        message: `Unexpected situation - stripe invoice item is null - stripe invoice id: '${stripeInvoice?.id }'`
      });
    }
    // Stripe invoice ID is not yet known - Let's create a pending invoice item
    if (!stripeInvoice) {
      // Let's create a new draft invoice (if none has been found)
      stripeInvoice = await this._createStripeInvoice(customerID, userID, this.buildIdemPotencyKey(idemPotencyKey));
    }
    let paymentOperationResult: BillingOperationResult;
    if (this.settings.immediateBillingAllowed) {
      // Let's try to bill the stripe invoice using the default payment method of the customer
      try {
        paymentOperationResult = await this._chargeStripeInvoice(stripeInvoice.id);
      } catch (error) {
        await Logging.logError({
          tenantID: this.tenantID,
          user: user.id,
          source: Constants.CENTRAL_SERVER,
          action: ServerAction.BILLING_TRANSACTION,
          module: MODULE_NAME, method: 'billInvoiceItem',
          message: `Payment attempt failed - stripe invoice: '${stripeInvoice?.id }'`,
          detailedMessages: { error: error.message, stack: error.stack }
        });
      }
    }
    // Let's replicate some information on our side
    const billingInvoice = await this.synchronizeAsBillingInvoice(stripeInvoice.id);
    // We have now a Billing Invoice - Let's update it with details about the last payment failure (if any)
    if (!paymentOperationResult?.succeeded && paymentOperationResult?.error) {
      await BillingStorage.saveLastPaymentFailure(this.tenantID, billingInvoice.id, paymentOperationResult.error);
    }
    // Return the billing invoice
    return billingInvoice;
  }

  private buildIdemPotencyKey(uniqueId: string, forLineItem = false): string {
    if (uniqueId) {
      return (forLineItem) ? 'item_' + uniqueId : 'invoice_' + uniqueId;
    }
    return null;
  }

  private buildLineItemDescription(transaction: Transaction) {
    let description: string;
    const chargeBox = transaction.chargeBox;
    const i18nManager = I18nManager.getInstanceForLocale(transaction.user.locale);
    const time = i18nManager.formatDateTime(transaction.stop.timestamp, 'LTS');
    const consumptionkWh = this.convertConsumptionToKWh(transaction);

    if (chargeBox && chargeBox.siteArea && chargeBox.siteArea.name) {
      description = i18nManager.translate('billing.chargingStopSiteArea', {
        totalConsumption: consumptionkWh,
        siteArea:
        chargeBox.siteArea,
        time: time
      });
    } else {
      description = i18nManager.translate('billing.chargingStopChargeBox', {
        totalConsumption: consumptionkWh, chargeBox: transaction.chargeBoxID, time: time
      });
    }
    return description;
  }

  private convertConsumptionToKWh(transaction: Transaction): number {
    return new Decimal(transaction.stop.totalConsumptionWh).dividedBy(10).round().dividedBy(100).toNumber();
  }

  public async checkIfUserCanBeCreated(user: User): Promise<boolean> {
    // Check
    return this.checkIfUserCanBeUpdated(user);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  public async checkIfUserCanBeUpdated(user: User): Promise<boolean> {
    // Check connection
    // await this.checkConnection();
    return true;
  }

  public async checkIfUserCanBeDeleted(user: User): Promise<boolean> {
    // Check connection
    await this.checkConnection();
    // No billing in progress
    if (!user.billingData || !user.billingData.customerID) {
      return true;
    }
    // Check connection
    await this.checkConnection();
    // Check invoices
    // OPENED
    let list = await this.stripe.invoices.list({
      customer: user.billingData.customerID,
      status: BillingInvoiceStatus.OPEN,
    });
    if (list && list.data && list.data.length > 0) {
      await Logging.logError({
        tenantID: this.tenantID,
        action: ServerAction.USER_DELETE,
        actionOnUser: user,
        module: MODULE_NAME, method: 'checkIfUserCanBeDeleted',
        message: 'Opened invoice still exist in Stripe'
      });
      return false;
    }
    // DRAFT
    list = await this.stripe.invoices.list({
      customer: user.billingData.customerID,
      status: BillingInvoiceStatus.DRAFT,
    });
    if (list && list.data && list.data.length > 0) {
      await Logging.logError({
        tenantID: this.tenantID,
        action: ServerAction.USER_DELETE,
        actionOnUser: user,
        module: MODULE_NAME, method: 'checkIfUserCanBeDeleted',
        message: 'Draft invoice still exist in Stripe'
      });
      return false;
    }
    // PENDING
    const itemsList = await this.stripe.invoiceItems.list({
      customer: user.billingData.customerID,
      pending: true,
    });
    if (itemsList && itemsList.data && itemsList.data.length > 0) {
      await Logging.logError({
        tenantID: this.tenantID,
        action: ServerAction.USER_DELETE,
        actionOnUser: user,
        module: MODULE_NAME, method: 'checkIfUserCanBeDeleted',
        message: 'Pending invoice still exist in Stripe'
      });
      return false;
    }
    return true;
  }

  public async createUser(user: User): Promise<BillingUser> {
    // Check
    const success = await this.checkIfUserCanBeUpdated(user);
    if (!success) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME, method: 'createUser',
        action: ServerAction.USER_CREATE,
        user: user,
        message: 'Cannot create the user'
      });
    }
    return this.generateStripeCustomer(user);
  }

  public async updateUser(user: User): Promise<BillingUser> {
    // Check
    const success = await this.checkIfUserCanBeUpdated(user);
    if (!success) {
      throw new BackendError({
        source: Constants.CENTRAL_SERVER,
        module: MODULE_NAME, method: 'updateUser',
        action: ServerAction.USER_CREATE,
        user: user,
        message: 'Cannot update the user'
      });
    }
    return this.generateStripeCustomer(user);
  }

  public async deleteUser(user: User): Promise<void> {
    // Check Stripe
    await this.checkConnection();
    // const customer = await this.getCustomerByEmail(user.email);
    const customerID = user.billingData?.customerID;
    const customer = await this.getStripeCustomer(customerID);
    if (customer && customer.id) {
      await this.stripe.customers.del(
        customer.id
      );
    }
  }

  private async getStripeCustomer(customerID: string): Promise<Stripe.Customer> {
    if (customerID) {
      try {
        // Gets the STRIPE Customer
        const customer: Stripe.Customer = await this.stripe.customers.retrieve(customerID) as Stripe.Customer;
        return customer;
      } catch (error) {
        // ---------------------------------------------------------------------------------------
        // This should not happen - The customerID
        // The customerID refers to something which does not exists anymore in the STRIPE account
        // May happen when billing settings are changed to point to a different STRIPE account
        // ---------------------------------------------------------------------------------------
        throw new BackendError({
          source: Constants.CENTRAL_SERVER,
          module: MODULE_NAME, method: 'getStripeCustomer',
          action: ServerAction.BILLING,
          message: `Stripe Inconsistency: ${error.message as string}`,
          detailedMessages: { error: error.message, stack: error.stack }
        });
      }
    }
    // No Customer in STRIPE DB so far!
    return null;
  }

  private async generateStripeCustomer(user: User): Promise<BillingUser> {
    await this.checkConnection();
    const fullName = Utils.buildUserFullName(user, false, false);
    const locale = Utils.getLanguageFromLocale(user.locale).toLocaleLowerCase();
    const i18nManager = I18nManager.getInstanceForLocale(user.locale);
    const description = i18nManager.translate('billing.generatedUser', { email: user.email });
    // Let's check if the STRIPE customer exists
    const customerID:string = user?.billingData?.customerID;
    let customer = await this.getStripeCustomer(customerID);
    if (!customer) {
      customer = await this.stripe.customers.create({
        email: user.email,
        description: description,
        name: fullName,
        preferred_locales: [locale],
        metadata: { userID: user.id } // IMPORTANT - keep track on the stripe side of the original eMobility user
      });
    }
    // Update user data
    const userDataToUpdate: Stripe.CustomerUpdateParams = {};
    if (customer.description !== description) {
      userDataToUpdate.description = description;
    }
    if (customer.name !== fullName) {
      userDataToUpdate.name = fullName;
    }
    if (customer.email !== user.email) {
      userDataToUpdate.email = user.email;
    }
    if (locale &&
      (!customer.preferred_locales ||
        customer.preferred_locales.length === 0 ||
        customer.preferred_locales[0] !== locale)) {
      userDataToUpdate.preferred_locales = [locale];
    }
    // Update
    customer = await this.stripe.customers.update(
      customer.id, userDataToUpdate
    );
    // Let's return the corresponding Billing User
    return this.convertToBillingUser(customer, user);
  }
}
