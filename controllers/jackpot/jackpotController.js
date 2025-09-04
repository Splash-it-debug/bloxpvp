const Item = require("../../models/item");
const InventoryItem = require("../../models/inventoryItem");
const Jackpot = require("../../models/jackpot");
const JackpotEntry = require("../../models/jackpotEntry");
const Account = require("../../models/account");
const asyncHandler = require("express-async-handler");
const { validationResult, body } = require("express-validator");
const mongoose = require("mongoose");
const crypto = require("crypto");
const { add } = require("date-fns");
const { XP_CONSTANT } = require("../../config");
const { emitEvent } = require("../../utils/events");


exports.join_jackpot = [

  asyncHandler(async (req, res, next) => {
    try {
      const recentJackpot = await Jackpot.findOne({ state: { $ne: "Ended" } }).exec();

      if (!recentJackpot) {
        return res.status(400).send("Jackpot game not found");
      }

      const recentEntry = await JackpotEntry.findOne({
        joiner: req.user.id,
        jackpotGame: recentJackpot._id,
      }).exec();

      if (recentEntry) {
        return res.status(409).send("User has already joined jackpot");
      }

      const playerInfo = await Account.findById(req.user.id).exec();

      if (playerInfo.robloxId == null) {
        return res.status(404).send("Your account does not exist");
      }

      if (req.body.chosenItems.length < 1) {
        return res.status(422).send("You must select at least 1 item");
      }

      let actualItems = [];
      for (chosenItem of req.body.chosenItems) {
        let exists = await InventoryItem.findOne({
          _id: chosenItem._id,
          locked: false,
          owner: req.user.id,
        })
          .populate("item")
          .exec();
        if (exists == null) {
          return res.status(422).send("Item doesn't exist");
        }
        if (exists.locked == true) {
          return res.status(409).send("You can not use a locked item");
        }
        if (exists.owner != req.user.id) {
          return res
            .status(409)
            .send("You can not use an item that isn't yours");
        }
        await InventoryItem.updateOne(
          { _id: exists._id },
          { locked: true }
        );
        actualItems.push(exists);
      }

      const chosenSum = actualItems.reduce(
        (accumulator, currentValue) =>
          accumulator + Number(currentValue.item.item_value),
        0
      );
      const max =
        recentJackpot.state == "Created"
          ? chosenSum * 5
          : recentJackpot.requirements.max;
      const state = recentJackpot.state == "Created" ? "Waiting" : "Started";

      if (chosenSum > max) {
        return res.status(400).send("Your bet amount exceeds the limit");
      }

      if (recentJackpot.state == "Waiting") {
        await Jackpot.updateOne(
          { _id: recentJackpot._id },
          {
            $inc: { value: chosenSum },
            requirements: {
              max: max,
            },
            state: state,
            endsAt: add(new Date(), {
              minutes: 1,
            }),
          }
        );
      } else {
        await Jackpot.updateOne(
          { _id: recentJackpot._id },
          {
            $inc: { value: chosenSum },
            requirements: {
              max: max,
            },
            state: state,
          }
        );
      }

      const newEntry = new JackpotEntry({
        joiner: req.user.id,
        joinerRobloxId: playerInfo.robloxId,
        value: chosenSum,
        items: actualItems,
        jackpotGame: recentJackpot._id,
        username: playerInfo.username,
        thumbnail: playerInfo.thumbnail,
      });
      await newEntry.save();

      let RoleToGive;

      if (playerInfo.rank == "User") {
        RoleToGive =
          XP_CONSTANT * Math.sqrt(playerInfo.wagered + chosenSum.value) > 40
            ? "Whale"
            : "User";
      } else {
        RoleToGive = playerInfo.rank;
      }

      await Account.updateOne(
        { _id: req.user.id },
        {
          $inc: { wagered: chosenSum, totalBets: 1 },
          level: XP_CONSTANT * Math.sqrt(playerInfo.wagered + chosenSum),
          rank: RoleToGive,
        }
      );

      res.sendStatus(200);

      const jackpotData = await getJackpot();
      emitEvent("JACKPOT_UPDATE", jackpotData);

      if (recentJackpot.state == "Waiting") {
        setTimeout(async () => {
          close_jackpot();
          play_jackpot();
          setTimeout(async () => {
            await Jackpot.findByIdAndUpdate(recentJackpot._id, {
              inactive: true,
            });
            create_jackpot();
          }, 18000);
        }, jackpotData.gameData.endsAt.getTime() - new Date().getTime());
      }
    } catch (error) {
      console.error("Error: ", error);
      res.sendStatus(500);
    }
  }),
];

const play_jackpot = asyncHandler(async (req, res, next) => {
  const activeJackpot = await Jackpot.findOne({ inactive: false });
  if (!activeJackpot) return; // safeguard

  const jackpotEntries = await JackpotEntry.find({
    jackpotGame: activeJackpot._id,
  }).populate({
    path: "items",
    populate: [
      {
        path: "item",
        model: Item,
      },
    ],
  });

  const totalAmount = jackpotEntries.reduce(
    (total, jackpotEntry) => total + jackpotEntry.value,
    0
  );
  const blockInfo = await commitToFutureBlock();
  const clientSeed = blockInfo.head_block_id.toString();
  const randomNumber = generateGameResult(
    clientSeed,
    activeJackpot.serverSeed,
    totalAmount
  );

  let cumulativeWeight = 0;
  let winner;

  for (const Entry of jackpotEntries) {
    cumulativeWeight += Entry.value;
    if (randomNumber <= cumulativeWeight) {
      winner = Entry.joiner;
      break;
    }
  }

  await Jackpot.findOneAndUpdate(
    { _id: activeJackpot._id },
    {
      winner: winner,
      clientSeed: clientSeed,
      EOSBlock: blockInfo.head_block_id,
      result: randomNumber,
    }
  );

  const taxItems = [];
  let payoutItems = [];
  let allItems = [];
  for (Entry of jackpotEntries) {
    for (EntryItem of Entry.items) {
      allItems.push(EntryItem);
    }
  }

  let toTax = activeJackpot.value / 10;

  for (let singleItem of allItems) {
    if (Number(singleItem.item.item_value) < toTax) {
      toTax -= Number(singleItem.item.item_value);
      taxItems.push(singleItem);
    } else {
      payoutItems.push(singleItem);
    }
  }
  for (let item of payoutItems) {
    await InventoryItem.updateOne(
      { _id: item._id },
      { locked: false, owner: winner }
    );
  }

  await Account.updateOne(
    { _id: winner },
    {
      $inc: { gameWins: 1 },
    }
  );

  const taxer = await Account.findOne({ robloxId: "5329316694" });
  for (let taxItem of taxItems) {
    await InventoryItem.updateOne(
      { _id: taxItem._id },
      {
        owner: taxer._id,
        locked: false,
      }
    );
  }

  const jackpotData = await getJackpot();
  emitEvent("JACKPOT_UPDATE", jackpotData);
});

const close_jackpot = asyncHandler(async (req, res, next) => {
  try {
    const activeJackpot = await Jackpot.findOne({
      inactive: false,
    }).exec();

    if (activeJackpot) {
      await Jackpot.updateOne(
        { _id: activeJackpot._id },
        {
          state: "Ended",
        }
      );
    }
  } catch (error) {
    console.error("Error: ", error);
  }
});

const create_jackpot = asyncHandler(async (req, res, next) => {
  try {
    const latestJP = await Jackpot.findOne({ state: { $ne: "Ended" } }).exec();
    if (latestJP) {
      return console.log("Jackpot exists");
    }

    let serverSeed = generateRandomSeed();
    const hashedServerSeed = crypto
      .createHash("sha256")
      .update(serverSeed)
      .digest("hex");
    const newJackpot = new Jackpot({
      value: 0,
      requirements: {
        max: 0,
      },
      winner: null,
      serverSeed: serverSeed,
      hashedServerSeed: hashedServerSeed,
      clientSeed: null,
      EOSBlock: null,
      endsAt: null,
      result: null,
      inactive: false,
      state: "Created",
    });
    await newJackpot.save();
    console.log("Created new jackpot");

    const jackpotData = await getJackpot();
    emitEvent("JACKPOT_UPDATE", jackpotData);
  } catch (error) {
    console.error("Error: ", error);
  }
});

exports.get_jackpot = asyncHandler(async (req, res, next) => {
  let activeJackpot = await Jackpot.find({}, { winner: 0 }).sort({
    $natural: -1,
  });
  activeJackpot = activeJackpot[0];
  if (!activeJackpot) {
    return res.status(404).send("No jackpot found");
  }
  const jackpotEntries = await JackpotEntry.find(
    {
      jackpotGame: activeJackpot._id,
    },
    { joiner: 0 }
  ).populate({
    path: "items",
    populate: [
      {
        path: "item",
        model: Item,
      },
    ],
  });
  return res.status(200).send({
    gameData: activeJackpot,
    entries: jackpotEntries,
  });
});

function generateRandomSeed() {
  return crypto.randomBytes(16).toString("hex");
}

async function commitToFutureBlock() {
  const response = await fetch("https://eos.greymass.com/");
  return await response.json();
}

function generateGameResult(clientSeed, serverSeed, totalAmount) {
  const combinedSeed = `${clientSeed}${serverSeed}`;

  const hash = crypto.createHash("sha256").update(combinedSeed).digest("hex");

  const randomNumber = parseInt(hash.slice(0, 8), 16) % (totalAmount + 1);
  return randomNumber;
}

async function getJackpot() {
  let activeJackpot = await Jackpot.find({}, { winner: 0 }).sort({
    $natural: -1,
  });
  activeJackpot = activeJackpot[0];
  if (!activeJackpot) return null;

  const jackpotEntries = await JackpotEntry.find(
    {
      jackpotGame: activeJackpot._id,
    },
    { joiner: 0 }
  ).populate({
    path: "items",
    populate: [
      {
        path: "item",
        model: Item,
      },
    ],
  });
  return {
    gameData: activeJackpot,
    entries: jackpotEntries,
  };
}

async function startupCheckUnfinished() {
  let currentJackpot = await Jackpot.find({}).sort({ $natural: -1 });
  currentJackpot = currentJackpot[0];

  // FIX: if no jackpot exists, create one
  if (!currentJackpot) {
    console.log("No jackpot found, creating one...");
    return create_jackpot();
  }

  if (currentJackpot.state != "Ended") {
    if (currentJackpot.endsAt > new Date()) {
      close_jackpot();
      play_jackpot();
      setTimeout(async () => {
        await Jackpot.findByIdAndUpdate(currentJackpot._id, {
          inactive: true,
        });
        create_jackpot();
      }, 18000);
    } else if (currentJackpot.state == "Started") {
      setTimeout(async () => {
        close_jackpot();
        play_jackpot();
        setTimeout(async () => {
          await Jackpot.findByIdAndUpdate(currentJackpot._id, {
            inactive: true,
          });
          create_jackpot();
        }, 18000);
      }, currentJackpot.endsAt.getTime() - new Date().getTime());
    }
  } else if (
    currentJackpot.state == "Ended" &&
    currentJackpot.inactive == false
  ) {
    play_jackpot();
    setTimeout(async () => {
      await Jackpot.findByIdAndUpdate(currentJackpot._id, {
        inactive: true,
      });
      create_jackpot();
    }, 18000);
  } else if (
    currentJackpot.state == "Ended" &&
    currentJackpot.inactive == true
  ) {
    create_jackpot();
  }
}

startupCheckUnfinished(); // Check for broken jackpots on startup
