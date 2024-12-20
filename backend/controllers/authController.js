const jwt = require('jsonwebtoken');
const User = require('../models/userModel');
const { promisify } = require('util');
const sendEmail = require('../utils/email');
const crypto = require('crypto');

const { handleMongoError } = require('../utils/errorHandler'); // Import the utility function

const multer = require('multer');
const sharp = require('sharp');

const filterObj = (obj, ...allowedFields) => {
  const newObj = {};
  Object.keys(obj).forEach((el) => {
    if (allowedFields.includes(el)) newObj[el] = obj[el];
  });
  return newObj;
};

// Multer storage and filter configuration
const multerStorage = multer.memoryStorage();

const multerFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image')) {
    cb(null, true);
  } else {
    cb(new Error('Not an image! Please upload only images.'), false);
  }
};

const upload = multer({
  storage: multerStorage,
  fileFilter: multerFilter,
});
// User image upload and resize
exports.uploadUserImage = upload.single('image');

exports.resizeUserImage = (req, res, next) => {
  if (!req.file) return next();
  console.log('req.file exists');
  req.file.filename = `user--${Date.now()}-${req.file.originalname}`;
  sharp(req.file.buffer)
    .resize(500, 500)
    .toFormat('jpeg')
    .jpeg({ quality: 90 })
    .toFile(`public/img/users/${req.file.filename}`);

  next();
};

const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN,
  });
};

const createsendToken = (user, statusCode, res) => {
  const token = signToken(user._id);
  const cookieOptions = {
    expires: new Date(
      Date.now() + process.env.JWT_COOKIE_EXPIRES_IN * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
  };
  res.cookie('jwt', token, cookieOptions);
  user.password = undefined;
  if (process.env.NODE_ENV === 'production') cookieOptions.secure = true;
  res.status(statusCode).json({
    status: 'success',
    token,
    data: {
      user,
    },
  });
};

exports.signup = async (req, res) => {
  try {
    const newUser = await User.create({
      username: req.body.username,
      email: req.body.email,
      password: req.body.password,
      passwordConfirm: req.body.passwordConfirm,
      phoneNumber: req.body.phoneNumber,
    });

    createsendToken(newUser, 201, res);
  } catch (err) {
    const message = handleMongoError(err); // Format the error message
    res.status(404).json({
      status: 'fail',
      message,
    });
  }
};
exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({
        status: 'fail',
        message: 'Please provide email and password',
      });
    }

    const user = await User.findOne({ email }).select('+password');

    if (!user || !(await user.correctPassword(password, user.password))) {
      return res.status(401).json({
        status: 'fail',
        message: 'Incorrect email or password',
      });
    }

    createsendToken(user, 200, res);
  } catch (err) {
    const message = handleMongoError(err); // Format the error message
    res.status(404).json({
      status: 'fail',
      message,
    });
  }
};

exports.protect = async (req, res, next) => {
  try {
    // 1) Getting token and check if it's there
    let token;
    console.log('protect', req.headers);
    if (
      req.headers.authorization &&
      req.headers.authorization.startsWith('Bearer')
    ) {
      token = req.headers.authorization.split(' ')[1];
    }
    // const jwtRegex = new RegExp(/jwt=.*$/i);
    // const JWTCookie = jwtRegex.test(req.headers.cookie)
    //   ? req.headers.cookie.match(/jwt=.*$/i)[0].split('=')[1]
    //   : null;
    // token = JWTCookie;
    console.log('hey token', token);
    if (!token) {
      return res.status(401).json({
        status: 'fail',
        message: 'You are not logged in! Please log in to get access.',
      });
    }
    // verify token
    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
    console.log(decoded);
    // check if user still exists
    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
      return res.status(401).json({
        status: 'fail',
        message: 'The user belonging to this token does no longer exist.',
      });
    }
    // check if user changed password after the token was issued

    console.log(
      'password ',
      currentUser.changePasswordAfter(decoded.iat),
      decoded.iat
    );
    if (currentUser.changePasswordAfter(decoded.iat)) {
      return res.status(401).json({
        status: 'fail',
        message: 'User recently changed password! Please log in again.',
      });
    }
    // GRANT ACCESS TO PROTECTED ROUTE
    req.user = currentUser;
    console.log(req.user);
    next();
  } catch (err) {
    res.status(404).json({
      status: 'fail',
      message: err,
    });
  }
};
exports.restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        status: 'fail',
        message: 'You do not have permission to perform this action',
      });
    }
    next();
  };
};
exports.forgotPassword = async (req, res) => {
  try {
    // 1) Get user based on POSTed email
    const user = await User.findOne({ email: req.body.email });
    if (!user) {
      return res.status(404).json({
        status: 'fail',
        message: 'There is no user with email address.',
      });
    }
    // 2) Generate the random reset token
    const resetToken = user.CreatePasswordResetToken();
    await user.save({ validateBeforeSave: false });
    // 3) Send it to user's email
    const resetURL = `${req.protocol}://${req.get(
      'host'
    )}/api/v1/users/resetPassword/${resetToken}`;

    const message = `Forgot your password? Submit a PATCH request with your new password and 
    passwordConfirm to: ${resetURL}.\nIf you didn't forget your password, please ignore this 
    email!`;
    try {
      await sendEmail({
        email: user.email,
        subject: 'Your password reset token (valid for 10 min)',
        message,
      });
      res.status(200).json({
        status: 'success',
        message: 'Token sent to email!',
      });
    } catch {
      user.passwordResetToken = undefined;
      user.passwordResetExpires = undefined;
      await user.save({ validateBeforeSave: false });
      return res.status(500).json({
        status: 'fail',
        message: 'There was an error sending the email. Try again later!',
      });
    }
  } catch (err) {
    res.status(404).json({
      status: 'fail',
      message: err,
    });
  }
};
exports.resetPassword = async (req, res) => {
  try {
    // 1) Get user based on the token
    const hashedToken = crypto
      .createHash('sha256')
      .update(req.params.token)
      .digest('hex');
    const user = await User.findOne({
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: Date.now() },
    });
    // 2) If token has not expired, and there is user, set the new password
    if (!user) {
      return res.status(400).json({
        status: 'fail',
        message: 'Token is invalid or has expired',
      });
    }
    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();
    // 3) Update changedPasswordAt property for the user
    // 4) Log the user in, send JWT

    createsendToken(user, 200, res);
  } catch (err) {
    res.status(404).json({
      status: 'fail',
      message: err,
    });
  }
};

exports.updatePassword = async (req, res) => {
  try {
    // 1) Get user from collection
    console.log(req.user.id);
    const user = await User.findById(req.user.id).select('+password');
    console.log(user);
    if (!user) {
      return res.status(404).json({
        status: 'fail',
        message: 'User not found',
      });
    }
    // 2) Check if POSTed current password is correct
    console.log(user.password);
    if (
      !(await user.correctPassword(req.body.passwordCurrent, user.password))
    ) {
      return res.status(401).json({
        status: 'fail',
        message: 'Your current password is wrong.',
      });
    }
    // 3) If so, update password
    user.password = req.body.password;
    user.passwordConfirm = req.body.passwordConfirm;

    await user.save();
    // User.findByIdAndUpdate will NOT work as intended!
    // we used save to run the validators and middleware
    // we created in the userModel for save
    // 4) Log user in, send JWT

    createsendToken(user, 200, res);
  } catch (err) {
    console.error('Error updating password:', err);
    res.status(500).json({
      status: 'fail',
      message:
        'There was an error updating the password. Please try again later.',
    });
  }
};

exports.logout = async (req, res) => {
  res.cookie('jwt', 'loggedout', {
    expires: new Date(Date.now() + 10 * 1000),
    httpOnly: true,
  });
  res.status(200).json({
    status: 'success',
  });
};
exports.updateMe = async (req, res) => {
  try {
    // 1) Create error if user POSTs password data
    if (req.body.password || req.body.passwordConfirm) {
      return res.status(400).json({
        status: 'fail',
        message:
          'This route is not for password updates. Please use /updateMyPassword.',
      });
    }

    // 2) Filter out unwanted fields names that are not allowed to be updated
    const filteredBody = filterObj(
      req.body,
      'username',
      'email',
      'phoneNumber',
      'location'
    );
    if (req.file) filteredBody.image = req.file.filename;

    console.log('filteredBody', filteredBody);
    // 3) Update user document
    const updatedUser = await User.findByIdAndUpdate(
      req.user.id,
      filteredBody,
      {
        new: true,
        runValidators: true,
      }
    );
    // SEND RESPONSE
    res.status(200).json({
      status: 'success',
      data: {
        user: updatedUser,
      },
    });
    console.log('User updated successfully');
  } catch (err) {
    const message = handleMongoError(err);
    res.status(404).json({
      status: 'fail',
      message,
    });
  }
};
