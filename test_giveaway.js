const mongoose = require('mongoose');
require('dotenv').config();

// Import models
const Item = require('./models/item');
const InventoryItem = require('./models/inventoryItem');
const Account = require('./models/account');
const Giveaway = require('./models/giveaway');

async function testGiveaway() {
  try {
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Find your account
    const yourAccount = await Account.findOne({ robloxId: '1087697965' });
    
    if (!yourAccount) {
      console.log('Account not found. Make sure you have an account first.');
      return;
    }

    console.log('Found account:', yourAccount.username || 'No username');

    // Check if you have any items in inventory
    const yourItems = await InventoryItem.find({ 
      owner: yourAccount._id, 
      locked: false 
    }).populate('item');

    if (yourItems.length === 0) {
      console.log('No unlocked items found in inventory. Add items first.');
      return;
    }

    console.log(`Found ${yourItems.length} unlocked items:`);
    yourItems.forEach((item, index) => {
      console.log(`${index + 1}. ${item.item.display_name} (${item.item.item_name}) - Value: $${item.item.item_value}`);
    });

    // Create a giveaway with the first item
    const firstItem = yourItems[0];
    
    const newGiveaway = new Giveaway({
      item: firstItem._id,
      host: yourAccount._id,
      winner: null,
      game: firstItem.game,
      endsAt: new Date(Date.now() + 1800000), // 30 minutes from now
      inactive: false,
      winnerImage: null,
      winnerName: null
    });

    await newGiveaway.save();
    console.log('✅ Giveaway created successfully!');
    console.log('Giveaway ID:', newGiveaway._id);
    console.log('Item:', firstItem.item.display_name);
    console.log('Ends at:', newGiveaway.endsAt);

    // Lock the item
    await InventoryItem.updateOne(
      { _id: firstItem._id },
      { locked: true }
    );
    console.log('✅ Item locked for giveaway');

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the test
testGiveaway();

