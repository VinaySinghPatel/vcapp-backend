import mongoose from 'mongoose';
import dotenv from 'dotenv';
dotenv.config();

async function connectToMongoDb() {
    try {
        await mongoose.connect(process.env.MONGO_URI);
        console.log('Connected to MongoDB');
    } catch (error) {
        console.log('Error connecting to MongoDB', error);
    }
}

export default connectToMongoDb;
