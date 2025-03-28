const express = require("express");
const { isAdmin, isUser } = require("../middleware/admin");
const Election = require("../models/election.model");
const Party = require("../models/party.model");
const Constituency = require("../models/constituency");
const Candidate = require("../models/candidates");
const TempElection = require("../models/temp-election.model");
const AllianceModel = require("../models/alliance.model");
const AssemblyElection = require("../models/assembly-election.model");
const RedisManager = require("../RedisManager");
const PartyElectionModel = require("../models/party-election-model");
const isLoggedIn = require("../middleware/login");
const CandidateElectioModel = require("../models/candidate-election-model");
const UserModel = require("./../models/user.model");
const ElectionConstituencyModel = require("./../models/constituency-election-model");
const ElectionModel = require("../models/temp-election.model");
const router = express.Router();
const mongoose = require("mongoose");

const redis = RedisManager.getInstance();

async function getCandidateElectionDetails(
  userType,
  electionId,
  allowedConstituencies
) {
  const pipeline = [
    { $match: { election: new mongoose.Types.ObjectId(electionId) } },

    {
      $lookup: {
        from: "candidates",
        localField: "candidate",
        foreignField: "_id",
        as: "candidateInfo",
      },
    },
    { $unwind: "$candidateInfo" },

    // Add user-specific filtering if needed
    ...(userType === "user"
      ? [
          {
            $match: {
              "candidateInfo.constituency.0": {
                $in: allowedConstituencies.map((id) =>
                  typeof id === "string" ? new mongoose.Types.ObjectId(id) : id
                ),
              },
            },
          },
        ]
      : []),

    // Lookup constituency data
    {
      $lookup: {
        from: "constituencies",
        localField: "candidateInfo.constituency.0",
        foreignField: "_id",
        as: "constituencyInfo",
      },
    },
    { $unwind: "$constituencyInfo" },

    // Lookup party data
    {
      $lookup: {
        from: "parties",
        localField: "candidateInfo.party",
        foreignField: "_id",
        as: "partyInfo",
      },
    },
    { $unwind: { path: "$partyInfo", preserveNullAndEmptyArrays: true } },

    // Lookup votes from electioncandidates
    {
      $lookup: {
        from: "electioncandidates",
        let: { candidateId: "$candidateInfo._id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  {
                    $eq: ["$election", new mongoose.Types.ObjectId(electionId)],
                  },
                  { $eq: ["$candidate", "$$candidateId"] },
                ],
              },
            },
          },
          {
            $project: {
              votesReceived: 1,
            },
          },
        ],
        as: "voteInfo",
      },
    },
    {
      $unwind: {
        path: "$voteInfo",
        preserveNullAndEmptyArrays: true,
      },
    },

    {
      $lookup: {
        from: "electionconstituencies",
        let: {
          electionId: new mongoose.Types.ObjectId(electionId),
          constituencyId: {
            $toObjectId: { $arrayElemAt: ["$candidateInfo.constituency", 0] },
          },
        },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$election", "$$electionId"] },
                  { $eq: ["$constituency", "$$constituencyId"] },
                ],
              },
            },
          },
        ],
        as: "constituencyElectionStatus",
      },
    },
    {
      $unwind: {
        path: "$constituencyElectionStatus",
        preserveNullAndEmptyArrays: true,
      },
    },

    // Project the final structure with votesReceived
    {
      $project: {
        _id: 1,
        election: 1,
        candidate: {
          _id: "$candidateInfo._id",
          name: "$candidateInfo.name",
          constituency: "$constituencyInfo",
          party: "$partyInfo",
          votesReceived: {
            $ifNull: ["$voteInfo.votesReceived", 0],
          },
        },
        constituencyStatus: {
          $cond: {
            if: { $ifNull: ["$constituencyElectionStatus", false] },
            then: "$constituencyElectionStatus.status",
            else: "unknown",
          },
        },
      },
    },
  ];

  // Execute the aggregation
  const candidateElections = await CandidateElectioModel.aggregate(pipeline);

  return candidateElections;
}

/* GET home page. */
router.get("/", function (req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  res.redirect("/temp-election-list");
});

router.get(
  "/edit-election/:id",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const electionId = req.params.id;
      console.log(electionId);
      const election = await Election.findById(electionId);
      console.log(election);
      if (!election) {
        return res.status(404).send("Election not found");
      }
      res.render("edit-election.ejs", { election, user: req.session.user });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/accounts-list", isLoggedIn, isAdmin, async (req, res) => {
  const users = await UserModel.find({}).populate(
    "allowedConstituencies",
    "name"
  );
  const constituencies = await Constituency.find({}, "_id name");

  console.log(users);

  res.render("accounts-list.ejs", {
    users,
    availableConstituencies: constituencies,
    userRole: req.userRole,
  });
});

router.get("/create-account", isLoggedIn, isAdmin, async (req, res) => {
  const constituencies = await Constituency.find({}, "_id name");
  res.render("create-accounts.ejs", { constituencies, userRole: req.userRole });
});

router.get("/create-election", isLoggedIn, isAdmin, function (req, res, next) {
  return res.render("create-election.ejs", { userRole: req.userRole });
});

router.get(
  "/alliance-election/:electionId",
  isLoggedIn,
  isUser,
  async (req, res) => {
    const { electionId } = req.params;

    const alliancesData = await AllianceModel.aggregate([
      // Match alliances for this election
      { $match: { election: new mongoose.Types.ObjectId(electionId) } },

      {
        $lookup: {
          from: "parties",
          localField: "parties",
          foreignField: "_id",
          as: "populatedParties",
        },
      },

      { $unwind: "$populatedParties" },

      {
        $lookup: {
          from: "electionpartyresults",
          let: {
            partyId: "$populatedParties._id",
            electionId: "$election",
          },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$party", "$$partyId"] },
                    { $eq: ["$election", "$$electionId"] },
                  ],
                },
              },
            },
            { $project: { seatsWon: 1, _id: 0 } },
          ],
          as: "partyResults",
        },
      },

      {
        $addFields: {
          seatsWon: {
            $ifNull: [{ $arrayElemAt: ["$partyResults.seatsWon", 0] }, 0],
          },
        },
      },

      {
        $group: {
          _id: "$_id",
          name: { $first: "$name" },
          election: { $first: "$election" },
          parties: {
            $push: {
              $mergeObjects: ["$populatedParties", { seatsWon: "$seatsWon" }],
            },
          },
        },
      },

      {
        $project: {
          _id: 1,
          name: 1,
          election: 1,
          parties: 1,
        },
      },
    ]);

    console.log("This is alliances data -> ", alliancesData);
    return res.render("alliance-election", {
      alliancesData,
      userRole: req.userRole,
    });
  }
);

router.get("/login", function (req, res, next) {
  if (req.session.user) {
    return res.redirect("/temp-election-list");
  }
  res.render("login.ejs");
});

router.get("/dashboard", isLoggedIn, isAdmin, function (req, res, next) {
  if (!req.session.user) {
    return res.redirect("/login");
  }
  if (!req.session.user || req.session.user.role !== "admin") {
    return res.render("dashboard.ejs", {
      error: "you are not authorized to use this resource",
    });
  }
  res.render("dashboard.ejs", { error: null, userRole: req.userRole });
});

router.get("/alliances", isLoggedIn, isAdmin, async (req, res) => {
  const alliances = await AllianceModel.find()
    .populate("leaderParty", "party")
    .populate("parties")
    .populate("election", "electionSlug");
  res.render("alliance.ejs", { alliances, userRole: req.userRole });
});

router.get("/edit-alliance/:id", async (req, res) => {
  const alliance = await AllianceModel.findById(req.params.id)
    .populate("parties", "party")
    .populate("leaderParty", "party");

  console.log(alliance);

  const allParties = await Party.find({}, "_id party");
  res.render("edit-alliance", { alliance, allParties, userRole: req.userRole });
});

router.get("/create-alliance", isLoggedIn, isAdmin, async (req, res) => {
  // const parties = await Party.aggregate([
  // 	{
  // 		$lookup: {
  // 			from: "alliances",
  // 			localField: "_id",
  // 			foreignField: "parties",
  // 			as: "allianceInfo",
  // 		},
  // 	},
  // 	{
  // 		$match: { allianceInfo: { $size: 0 } },
  // 	},
  // 	{
  // 		$project: { _id: 1, party: 1 },
  // 	},
  // ]);
  const ongoingElections = await ElectionModel.find({ status: "ongoing" });
  res.render("create-alliance.ejs", {
    parties: [],
    userRole: req.userRole,
    ongoingElections,
  });
});

router.get("/temp-create-election", isLoggedIn, isAdmin, async (req, res) => {
  const parties = await Party.find({}, "_id party");
  const candidates = await Candidate.find()
    .populate("party", "party")
    .populate("constituency", "name");
  res.render("temp-create-election.ejs", {
    parties,
    candidates,
    userRole: req.userRole,
  });
});

router.get(
  "/temp-edit-election/:id",
  isLoggedIn,
  isUser,
  async function (req, res, next) {
    try {
      const electionId = req.params.id;

      const election = await TempElection.findById(electionId)
        .populate("electionInfo.partyIds")
        .populate({
          path: "electionInfo.candidates",
          populate: [{ path: "party" }, { path: "constituency" }],
        });

      if (!election) {
        return res.status(404).send("Election not found");
      }
      const electionConstituencies = await ElectionConstituencyModel.find({
        election: electionId,
      }).populate("constituency");

      let partyElectionDetails;
      let candidateElectionDetails;

      if (req.userRole === "user") {
        candidateElectionDetails = await getCandidateElectionDetails(
          req.userRole,
          electionId,
          req.allowedConst
        );

        candidateElectionDetails = candidateElectionDetails.filter(
          (doc) => doc.candidate !== null
        );

        const allowedParties = candidateElectionDetails.map(
          (candidate) => candidate.candidate.party._id
        );

        partyElectionDetails = await PartyElectionModel.find({
          party: { $in: allowedParties },
          election: electionId,
        }).populate("party");
      } else {
        partyElectionDetails = await PartyElectionModel.find({
          election: electionId,
        }).populate("party");

        candidateElectionDetails = await getCandidateElectionDetails(
          req.userRole,
          electionId,
          req.allowedConst
        );
      }

      const partyIdsInElection = partyElectionDetails.map((partyElection) =>
        partyElection.party._id.toString()
      );

      const candidatesInElection = candidateElectionDetails.map(
        (candidateElection) => candidateElection.candidate._id.toString()
      );

      const allPartiesList = await Party.find(
        { _id: { $nin: partyIdsInElection } },
        "party"
      );

      const candidatesQuery = {
        _id: { $nin: candidatesInElection },
        party: { $in: partyIdsInElection },
      };

      const allCandidatesList = await Candidate.find(candidatesQuery, "name")
        .populate("party", "party")
        .populate("constituency", "name");

      res.render("temp-edit-election.ejs", {
        election,
        user: req.session.user,
        partyElectionDetails,
        candidateElectionDetails,
        allPartiesList,
        allCandidatesList,
        electionConstituencies,
        userRole: req.userRole,
      });
    } catch (error) {
      next(error);
    }
  }
);

router.get("/temp-election-list", isLoggedIn, isUser, async (req, res) => {
  try {
    const elections = await TempElection.aggregate([
      {
        $lookup: {
          from: "electionpartyresults",
          localField: "electionInfo.partyIds",
          foreignField: "party",
          as: "partyResults",
        },
      },
      {
        $lookup: {
          from: "electioncandidates",
          localField: "electionInfo.candidates",
          foreignField: "candidate",
          as: "candidateResults",
        },
      },
      {
        $lookup: {
          from: "parties",
          localField: "electionInfo.partyIds",
          foreignField: "_id",
          as: "parties",
        },
      },
      {
        $lookup: {
          from: "candidates",
          localField: "electionInfo.candidates",
          foreignField: "_id",
          as: "candidates",
        },
      },
      {
        $lookup: {
          from: "constituencies",
          localField: "candidates.constituency.0", // Access the first element of each candidate's constituency array
          foreignField: "_id",
          as: "constituencies",
        },
      },
      {
        $addFields: {
          "electionInfo.partyIds": {
            $map: {
              input: "$parties",
              as: "party",
              in: {
                $mergeObjects: [
                  "$$party",
                  {
                    seatsWon: {
                      $let: {
                        vars: {
                          result: {
                            $arrayElemAt: [
                              {
                                $filter: {
                                  input: "$partyResults",
                                  as: "result",
                                  cond: {
                                    $eq: ["$$result.party", "$$party._id"],
                                  },
                                },
                              },
                              0,
                            ],
                          },
                        },
                        in: "$$result.seatsWon",
                      },
                    },
                    votes: {
                      $sum: {
                        $map: {
                          input: {
                            $filter: {
                              input: "$candidates",
                              as: "candidate",
                              cond: {
                                $eq: ["$$candidate.party", "$$party._id"],
                              },
                            },
                          },
                          as: "candidate",
                          in: {
                            $let: {
                              vars: {
                                result: {
                                  $arrayElemAt: [
                                    {
                                      $filter: {
                                        input: "$candidateResults",
                                        as: "result",
                                        cond: {
                                          $eq: [
                                            "$$result.candidate",
                                            "$$candidate._id",
                                          ],
                                        },
                                      },
                                    },
                                    0,
                                  ],
                                },
                              },
                              in: "$$result.votesReceived",
                            },
                          },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
          "electionInfo.candidates": {
            $map: {
              input: "$candidates",
              as: "candidate",
              in: {
                $mergeObjects: [
                  "$$candidate",
                  {
                    votesReceived: {
                      $let: {
                        vars: {
                          result: {
                            $arrayElemAt: [
                              {
                                $filter: {
                                  input: "$candidateResults",
                                  as: "result",
                                  cond: {
                                    $eq: [
                                      "$$result.candidate",
                                      "$$candidate._id",
                                    ],
                                  },
                                },
                              },
                              0,
                            ],
                          },
                        },
                        in: "$$result.votesReceived",
                      },
                    },
                    party: {
                      $arrayElemAt: [
                        {
                          $filter: {
                            input: "$parties",
                            as: "party",
                            cond: {
                              $eq: ["$$party._id", "$$candidate.party"],
                            },
                          },
                        },
                        0,
                      ],
                    },
                    constituency: [
                      {
                        $arrayElemAt: [
                          {
                            $filter: {
                              input: "$constituencies",
                              as: "constituency",
                              cond: {
                                $eq: [
                                  "$$constituency._id",
                                  {
                                    $arrayElemAt: [
                                      "$$candidate.constituency",
                                      0,
                                    ],
                                  },
                                ],
                              },
                            },
                          },
                          0,
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      {
        $project: {
          partyResults: 0,
          candidateResults: 0,
          parties: 0,
          candidates: 0,
          constituencies: 0,
        },
      },
    ]);

    // Render the template with the elections data
    res.render("temp-election-list.ejs", { elections, userRole: req.userRole });
  } catch (error) {
    console.error("Error fetching elections:", error);
    res.status(500).render("error.ejs", {
      message: "Failed to fetch elections data",
      error,
    });
  }
});

// create a party route
router.get("/parties", isLoggedIn, isAdmin, async function (req, res, next) {
  try {
    const parties = await Party.find(); // Fetch all parties from the database
    return res.render("party.ejs", { parties, userRole: req.userRole });
  } catch (error) {
    console.log(error);
    res.status(500).send("Error fetching parties");
  }
});

// create party page
router.get("/create-party", isLoggedIn, isAdmin, function (req, res, next) {
  res.render("create-party.ejs", { userRole: req.userRole });
});

router.get(
  "/edit-party/:id",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const partyId = req.params.id;
      const party = await Party.findById(partyId);
      if (!party) {
        return res.status(404).send("Party not found");
      }
      res.render("edit-party.ejs", { party, userRole: req.userRole });
    } catch (error) {
      next(error);
    }
  }
);

// create constituency route
router.get(
  "/constituency",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const constituencies = await Constituency.find()
        .populate({
          path: "candidates",
          model: "Candidate",
          populate: {
            path: "party",
            model: "Party",
          },
        })
        .sort({ name: 1 }); // Fetch all constituencies from the database

      return res.render("constituency.ejs", {
        constituencies,
        userRole: req.userRole,
      });
    } catch (error) {
      console.log(error);
      res.status(500).send("Error fetching constituencies");
    }
  }
);

// create constituency page create-constituency
router.get(
  "/create-constituency",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    const candidates = await Candidate.find();
    const errorMessages = req.flash("error");
    res.render("create-constituency.ejs", {
      candidates,
      error: errorMessages,
      userRole: req.userRole,
    });
  }
);

router.get(
  "/edit-constituency/:id",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const constituencyId = req.params.id;
      const constituency = await Constituency.findById(constituencyId).populate(
        {
          path: "candidates",
          model: "Candidate",
          populate: {
            path: "party",
            model: "Party",
          },
        }
      );
      if (!constituency) {
        return res.status(404).send("Constituency not found");
      }
      // get all the candidates
      const candidates = await Candidate.find().populate("party");
      res.render("edit-constituency.ejs", {
        constituency,
        candidates,
        error: null,
        userRole: req.userRole,
      });
    } catch (error) {
      console.log(error);
    }
  }
);

router.get("/candidates", isLoggedIn, isAdmin, async function (req, res, next) {
  try {
    const page = parseInt(req.query.page) || 1; // Get the current page number from query params
    const limit = parseInt(req.query.limit) || 10; // Set the limit of items per page
    const search = req.query.search || ""; // Get the search term from query params
    const skip = (page - 1) * limit; // Calculate the number of items to skip

    const cacheKey = `candidates:${page}:${limit}:${search}`; // Cache key based on page, limit, and search term

    // Try to fetch data from Redis cache
    const cachedData = await redis.get(cacheKey);

    if (cachedData) {
      // If data is found in the cache, return it
      return res.render("candidate.ejs", {
        candidates: cachedData.candidates,
        currentPage: page,
        totalPages: cachedData.totalPages,
        userRole: req.userRole,
        limit,
        search,
      });
    }

    // Create a search filter for MongoDB
    const searchFilter = search
      ? {
          $or: [
            { name: { $regex: search, $options: "i" } }, // Case-insensitive search in name
            { "party.name": { $regex: search, $options: "i" } }, // Search in party name
            { "constituency.name": { $regex: search, $options: "i" } }, // Search in constituency name
          ],
        }
      : {};

    // Query the database
    const candidates = await Candidate.find(searchFilter)
      .populate("party constituency")
      .skip(skip) // Skip the items based on pagination
      .limit(limit); // Limit the number of items returned

    const totalCandidates = await Candidate.countDocuments(searchFilter); // Get the total number of candidates matching the search

    // Calculate total pages
    const totalPages = Math.ceil(totalCandidates / limit);

    // Store the data in Redis with TTL of 3600 seconds (1 hour)
    const dataToCache = {
      candidates,
      totalPages,
    };
    await redis.setWithTTL(cacheKey, dataToCache, 3600);

    return res.render("candidate.ejs", {
      candidates: candidates || [],
      currentPage: page,
      totalPages,
      limit,
      search,
      userRole: req.userRole,
    });
  } catch (error) {
    console.log(error);
    res.status(500).send("Error fetching candidates");
  }
});

router.get(
  "/create-candidate",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const parties = await Party.find(); // Fetch all parties
      const constituencies = await Constituency.find(); // Fetch all constituencies
      return res.render("create-candidate.ejs", {
        parties,
        constituencies,
        error: null,
        userRole: req.userRole,
      });
    } catch (error) {
      console.log(error);
      res.status(500).send("Error fetching data for creating candidate");
    }
  }
);

router.get(
  "/edit-candidate/:id",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const candidateId = req.params.id;
      const candidate = await Candidate.findById(candidateId).populate(
        "party constituency"
      );
      if (!candidate) {
        return res.status(404).send("Candidate not found");
      }
      const parties = await Party.find(); // Fetch all parties
      const constituencies = await Constituency.find(); // Fetch all constituencies
      res.render("edit-candidate.ejs", {
        candidate,
        parties,
        constituencies,
        userRole: req.userRole,
      });
    } catch (error) {
      console.log(error);
      res.status(500).send("Error fetching data for editing candidate");
    }
  }
);

// create for assembly-election
router.get(
  "/create-assembly-election",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const constituencies = await Constituency.find(); // Fetch all constituencies
      return res.render("create-assembly-election.ejs", {
        constituencies,
        error: null,
      });
    } catch (error) {
      console.log(error);
      res
        .status(500)
        .send("Error fetching data for creating assembly election");
    }
  }
);

// create for edit assembly-election
router.get(
  "/edit-assembly-election/:id",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const electionId = req.params.id;
      const assemblyElection = await AssemblyElection.findById(electionId);
      if (!assemblyElection) {
        return res.status(404).send("Assembly election not found");
      }
      const elections = await Election.find(); // Fetch all elections
      const constituencies = await Constituency.find(); // Fetch all constituencies
      res.render("edit-assembly-election.ejs", {
        assemblyElection,
        elections,
        constituencies,
        userRole: req.userRole,
      });
    } catch (error) {
      console.log(error);
      res.status(500).send("Error fetching data for editing assembly election");
    }
  }
);

// get route for show the assembly-election
router.get(
  "/assembly-election",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const assemblyElections = await AssemblyElection.find().populate(
        "constituencies"
      ); // Fetch all elections
      res.render("assembly-election.ejs", {
        assemblyElections,
        userRole: req.userRole,
      });
    } catch (error) {
      console.log(error);
      res.status(500).send("Error fetching assembly election");
    }
  }
);

router.get(
  "/cons-candidates",
  isLoggedIn,
  isAdmin,
  async function (req, res, next) {
    try {
      const constituencies = await Constituency.find().sort({ name: 1 });
      const parties = await Party.find();

      if (req.query.cons) {
        // Find constituency by name (case-insensitive) and fetch candidates associated with it
        const constituency = await Constituency.findOne({
          name: { $regex: req.query.cons, $options: "i" },
        });

        // If the constituency does not exist, render empty candidates array
        const candidates = constituency
          ? await Candidate.find({ constituency: constituency._id })
              .populate("party")
              .sort({ totalVotes: -1 }) // Sort candidates by totalVotes in descending order
          : [];

        return res.render("cons-candidates.ejs", {
          candidates,
          constituencies,
          parties,
          selectedCons: req.query.cons, // Pass selected constituency name to the template
        });
      }

      // Render with all candidates if no constituency selected
      const candidates = await Candidate.find()
        .populate("party")
        .sort({ totalVotes: -1 }); // Sort all candidates by totalVotes in descending order

      res.render("cons-candidates.ejs", {
        candidates,
        constituencies,
        parties,
        selectedCons: "", // No constituency selected by default
        userRole: req.userRole,
      });
    } catch (error) {
      console.log(error);
      res.status(500).send("Error fetching candidates.");
    }
  }
);

module.exports = router;
